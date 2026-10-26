// Auth wall: verificación del móvil, alta del cliente (expediente en customers) e invitación a instalar la app.
// Al terminar devuelve al cliente a la página que intentaba abrir (?next=).
import { doc, serverTimestamp, setDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { auth } from "./auth.js";
import { isTestPhone, mountEnvBanner, TEST_MODE, TEST_OTP, TEST_PHONES_LABEL } from "./env.js";
import { db } from "./firebase.js";
import { createPhoneLogin, phoneAuthErrorMessage } from "./phone-auth.js";
import { isStandalone, mountInstallPrompt, registerServiceWorker } from "./pwa.js";
import { endSession, getProfile, getSession, hasCompletedProfile, safeNext, startTestSession } from "./session.js";
import { normalizePhone, showMessage, storage, withBusy } from "./shared.js";

mountEnvBanner();
registerServiceWorker();
const phoneLogin = createPhoneLogin(auth, 'recaptcha-container');

const $ = id => document.getElementById(id);
const message = $('accessMessage');
const STEPS = ['stepLoading', 'stepPhone', 'stepVerify', 'stepProfile', 'stepWelcome'];

const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'));
// Código de referido de un enlace compartido (index.html?ref=600123456), aunque llegue a través del muro
const referralFromLink = new URLSearchParams(next.split('?')[1] || '').get('ref') || params.get('ref') || storage.get('pachoncito_ref');

let pendingTestPhone = null;
let session = null;
let existingProfile = null;

function showStep(stepId) {
    STEPS.forEach(id => { $(id).hidden = id !== stepId; });
}

function goNext() {
    location.replace(next);
}

// ---------- Paso 1 y 2: verificación del móvil ----------

$('loginPhone').value = storage.get('pachoncito_user')?.phone || '';

$('sendCodeBtn').addEventListener('click', async event => {
    const phone = normalizePhone($('loginPhone').value);
    if (!phone) {
        showMessage(message, 'Introduce un número de teléfono válido (9 cifras o formato +34…).', 'error');
        return;
    }

    // Teléfono de prueba: ni reCAPTCHA ni SMS de Firebase
    if (isTestPhone(phone)) {
        pendingTestPhone = phone;
        showStep('stepVerify');
        $('smsCode').value = TEST_OTP;
        showMessage(message, `🧪 Número de prueba: no se envía SMS. Usa el código ${TEST_OTP} (ya rellenado).`, 'success');
        $('verifyBtn').focus();
        return;
    }

    // En modo pruebas no se envían SMS reales
    if (TEST_MODE) {
        showMessage(message, `🧪 Modo pruebas: usa un teléfono de prueba (${TEST_PHONES_LABEL}) con el código ${TEST_OTP}. Para un SMS real, abre la página con ?pruebas=0.`, 'error');
        return;
    }

    pendingTestPhone = null;
    try {
        const { suggestedCode } = await withBusy(event.currentTarget, 'Enviando SMS…', () => phoneLogin.send(phone));
        showStep('stepVerify');
        $('smsCode').value = suggestedCode || '';
        showMessage(message, suggestedCode
            ? '🧪 Emulador: no se envía SMS y el código ya está rellenado.'
            : '¡Código SMS enviado a tu móvil!', 'success');
        $(suggestedCode ? 'verifyBtn' : 'smsCode').focus();
    } catch (error) {
        console.error('Error al enviar el SMS:', error);
        showMessage(message, phoneAuthErrorMessage(error), 'error');
    }
});

$('verifyBtn').addEventListener('click', async event => {
    const code = $('smsCode').value.trim();
    if (!/^\d{6}$/.test(code)) {
        showMessage(message, 'Introduce el código de 6 dígitos.', 'error');
        return;
    }

    try {
        if (pendingTestPhone) {
            if (code !== TEST_OTP) throw Object.assign(new Error('Código de prueba incorrecto'), { code: 'auth/invalid-verification-code' });
            startTestSession(pendingTestPhone);
        } else {
            await withBusy(event.currentTarget, 'Verificando…', () => phoneLogin.confirm(code));
        }
        showMessage(message, '');
        await afterLogin();
    } catch (error) {
        console.error('Error al verificar el código:', error);
        showMessage(message, phoneAuthErrorMessage(error), 'error');
    }
});

$('changePhoneBtn').addEventListener('click', () => {
    pendingTestPhone = null;
    showMessage(message, '');
    showStep('stepPhone');
});

// ---------- Paso 3: alta del cliente ----------

async function afterLogin() {
    showStep('stepLoading');
    session = await getSession();
    if (!session) {
        showStep('stepPhone');
        return;
    }

    try {
        existingProfile = await getProfile(session.phone);
    } catch (error) {
        console.error('Error leyendo el expediente:', error);
        showStep('stepPhone');
        showMessage(message, 'No hemos podido cargar tu cuenta. Inténtalo de nuevo en unos minutos.', 'error');
        return;
    }

    if (hasCompletedProfile(existingProfile)) {
        goNext();
        return;
    }

    // Cliente nuevo: onboarding
    const saved = storage.get('pachoncito_user') || {};
    $('regAddress').value = existingProfile?.address || saved.address || '';
    const referral = normalizePhone(referralFromLink);
    if (referral && referral !== session.phone) {
        document.querySelector('input[name="isReferenced"][value="si"]').checked = true;
        $('refPhoneContainer').hidden = false;
        $('friendPhone').value = referral;
    }
    // Si el obrador ya creó el expediente (pedidos anteriores al muro), el referido ya no aplica
    $('referralPanel').hidden = Boolean(existingProfile);
    showStep('stepProfile');
    $('regNames').focus();
}

document.querySelectorAll('input[name="isReferenced"]').forEach(radio => {
    radio.addEventListener('change', () => {
        $('refPhoneContainer').hidden = document.querySelector('input[name="isReferenced"]:checked').value !== 'si';
    });
});

$('infoBtn').addEventListener('click', () => $('infoModal').showModal());
$('closeInfoBtn').addEventListener('click', () => $('infoModal').close());

$('saveProfileBtn').addEventListener('click', async event => {
    const name = `${$('regNames').value.trim()} ${$('regSurnames').value.trim()}`.trim();
    const address = $('regAddress').value.trim();
    const isReferenced = !existingProfile && document.querySelector('input[name="isReferenced"]:checked').value === 'si';
    const referralCode = isReferenced ? normalizePhone($('friendPhone').value) : null;

    if (name.length < 2) {
        showMessage(message, 'Escribe tu nombre para crear la cuenta.', 'error');
        $('regNames').focus();
        return;
    }
    if (isReferenced && !referralCode) {
        showMessage(message, 'El teléfono de tu recomendador no es válido.', 'error');
        return;
    }
    if (referralCode === session.phone) {
        showMessage(message, 'No puedes recomendarte a ti mismo 😉', 'error');
        return;
    }

    const customerRef = doc(db, 'customers', session.phone);
    try {
        await withBusy(event.currentTarget, 'Creando tu cuenta…', () => existingProfile
            ? updateDoc(customerRef, { name, address, updatedAt: serverTimestamp() })
            : setDoc(customerRef, {
                name,
                phone: session.phone,
                address,
                ...(referralCode ? { referralCode } : {}),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }));
    } catch (error) {
        console.error('Error creando el expediente:', error);
        showMessage(message, 'No se pudo crear tu cuenta. Inténtalo de nuevo.', 'error');
        return;
    }

    storage.set('pachoncito_user', { name, phone: session.phone, address });
    storage.remove('pachoncito_ref');
    showMessage(message, '');

    // ---------- Paso 4: bienvenida e invitación a instalar ----------
    if (isStandalone()) {
        goNext();
        return;
    }
    $('continueBtn').textContent = next.startsWith('index.html') ? 'Hacer mi primer pedido 🥖' : 'Continuar';
    mountInstallPrompt($('installSlot'), { afterSignup: true });
    showStep('stepWelcome');
});

$('continueBtn').addEventListener('click', goNext);

$('logoutBtn').addEventListener('click', async () => {
    await endSession();
    session = null;
    showMessage(message, '');
    showStep('stepPhone');
});

// ---------- Inicio ----------

if (referralFromLink) storage.set('pachoncito_ref', referralFromLink);
afterLogin();
