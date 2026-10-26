import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { app } from "./firebase.js";
import { createPhoneLogin, phoneAuthErrorMessage } from "./phone-auth.js";
import { normalizePhone, showMessage, storage, withBusy } from "./shared.js";

const auth = getAuth(app);
auth.languageCode = 'es';
const phoneLogin = createPhoneLogin(auth, 'recaptcha-container');

const $ = id => document.getElementById(id);
const message = $('accessMessage');
const STEPS = ['stepChoice', 'stepRegister', 'stepLogin', 'stepVerify'];
let pendingProfile = null;

function showStep(stepId) {
    STEPS.forEach(id => { $(id).hidden = id !== stepId; });
    showMessage(message, '');
}

document.addEventListener('click', event => {
    const target = event.target.closest('[data-step]');
    if (target) showStep(target.dataset.step);
});

document.querySelectorAll('input[name="isReferenced"]').forEach(radio => {
    radio.addEventListener('change', () => {
        $('refPhoneContainer').hidden = document.querySelector('input[name="isReferenced"]:checked').value !== 'si';
    });
});

$('infoBtn').addEventListener('click', () => $('infoModal').showModal());
$('closeInfoBtn').addEventListener('click', () => $('infoModal').close());

async function sendCode(phone, button) {
    try {
        await withBusy(button, 'Enviando SMS…', () => phoneLogin.send(phone));
        showStep('stepVerify');
        showMessage(message, '¡Código SMS enviado a tu móvil!', 'success');
        $('smsCode').focus();
    } catch (error) {
        console.error('Error al enviar el SMS:', error);
        showMessage(message, phoneAuthErrorMessage(error), 'error');
    }
}

$('registerBtn').addEventListener('click', event => {
    const names = $('regNames').value.trim();
    const surnames = $('regSurnames').value.trim();
    const phone = normalizePhone($('regPhone').value);
    const address = $('regAddress').value.trim();
    const isReferenced = document.querySelector('input[name="isReferenced"]:checked').value === 'si';
    const referral = isReferenced ? normalizePhone($('friendPhone').value) : null;

    if (!names || !phone || !address) {
        showMessage(message, 'Completa al menos tu nombre, un teléfono válido y tu dirección.', 'error');
        return;
    }
    if (isReferenced && !referral) {
        showMessage(message, 'El teléfono de tu recomendador no es válido.', 'error');
        return;
    }
    if (referral === phone) {
        showMessage(message, 'No puedes recomendarte a ti mismo 😉', 'error');
        return;
    }

    pendingProfile = { name: `${names} ${surnames}`.trim(), phone, address, referral };
    sendCode(phone, event.currentTarget);
});

$('loginBtn').addEventListener('click', event => {
    const phone = normalizePhone($('loginPhone').value);
    if (!phone) {
        showMessage(message, 'Introduce un número de teléfono válido.', 'error');
        return;
    }
    pendingProfile = { phone };
    sendCode(phone, event.currentTarget);
});

$('verifyBtn').addEventListener('click', async event => {
    const code = $('smsCode').value.trim();
    if (!/^\d{6}$/.test(code)) {
        showMessage(message, 'Introduce el código de 6 dígitos.', 'error');
        return;
    }

    try {
        await withBusy(event.currentTarget, 'Verificando…', () => phoneLogin.confirm(code));

        // Solo datos de comodidad para rellenar el pedido; las ñapas reales viven en Firestore (customers)
        const { referral, ...profile } = pendingProfile;
        storage.set('pachoncito_user', { ...(storage.get('pachoncito_user') || {}), ...profile });
        if (referral) storage.set('pachoncito_ref', referral);

        showMessage(message, '¡Verificación completada! Redirigiendo a la tienda…', 'success');
        setTimeout(() => { location.href = 'index.html'; }, 900);
    } catch (error) {
        console.error('Error al verificar el código:', error);
        showMessage(message, phoneAuthErrorMessage(error), 'error');
    }
});
