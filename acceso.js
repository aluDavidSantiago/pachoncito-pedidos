// Auth wall de clientes: Google Sign-In (popup), alta con vinculación única del teléfono,
// invitación a instalar la app y vuelta a la página de origen (?next=).
import {
    GoogleAuthProvider, signInAnonymously, signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    doc, getDoc, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { auth } from "./auth.js";
import { isTestPhone, mountEnvBanner, TEST_MODE, TEST_PHONES_LABEL } from "./env.js";
import { mountFaq } from "./faq.js";
import { db } from "./firebase.js";
import { hydrateIcons } from "./icons.js";
import { isStandalone, mountInstallPrompt, registerServiceWorker } from "./pwa.js";
import { endSession, getProfile, getSession, hasCompletedProfile, safeNext } from "./session.js";
import { normalizePhone, showMessage, storage, withBusy } from "./shared.js";

mountEnvBanner();
registerServiceWorker();
hydrateIcons();
mountFaq();

const $ = id => document.getElementById(id);
const message = $('accessMessage');
const STEPS = ['stepLoading', 'stepInApp', 'stepSignIn', 'stepProfile', 'stepWelcome'];

const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'));

// Código de invitación de un enlace compartido (index.html?ref=ANA-7K3P), aunque llegue a través del muro
const REFERRAL_CODE = /^[A-Z]{3}-[A-Z2-9]{4}$/;
const inviteFromLink = (new URLSearchParams(next.split('?')[1] || '').get('ref') || params.get('ref') || '').toUpperCase();
if (REFERRAL_CODE.test(inviteFromLink)) storage.set('pachoncito_ref', inviteFromLink);

// Navegadores internos (WebView) donde Google bloquea el inicio de sesión (error 403 disallowed_useragent)
const IN_APP_BROWSER = /Instagram|FBAN|FBAV|FB_IAB|FBIOS|Messenger|Line\/|TikTok|musical_ly|BytedanceWebview|Snapchat|; wv\)/i
    .test(navigator.userAgent);
const IS_ANDROID = /Android/i.test(navigator.userAgent);

let session = null;
let profile = null;

function showStep(stepId) {
    STEPS.forEach(id => { $(id).hidden = id !== stepId; });
}

function goNext() {
    location.replace(next);
}

// ---------- Navegador interno ----------

function showInAppHelp() {
    if (IS_ANDROID) {
        const target = `${location.host}${location.pathname}${location.search}`;
        $('openChromeLink').href = `intent://${target}#Intent;scheme=https;package=com.android.chrome;end`;
        $('openChromeLink').hidden = false;
    }
    showStep('stepInApp');
}

$('copyLinkBtn').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(location.href);
        showMessage(message, 'Enlace copiado. Pégalo en Chrome o Safari.', 'success');
    } catch {
        showMessage(message, `Copia este enlace: ${location.href}`, 'info');
    }
});

$('tryAnywayBtn').addEventListener('click', () => {
    showMessage(message, '');
    showStep('stepSignIn');
});

// ---------- Paso 1: inicio de sesión ----------

function googleErrorMessage(error) {
    switch (error?.code) {
        case 'auth/popup-blocked':
            return 'Tu navegador ha bloqueado la ventana de Google. Permite las ventanas emergentes para esta página y vuelve a intentarlo.';
        case 'auth/operation-not-supported-in-this-environment':
        case 'auth/web-storage-unsupported':
            return 'Este navegador no permite iniciar sesión (¿modo privado o navegador de una app?). Prueba con Chrome o Safari.';
        case 'auth/unauthorized-domain':
            return 'Este dominio no está autorizado para iniciar sesión. Avisa a la tienda.';
        case 'auth/operation-not-allowed':
            return 'Este método de acceso no está activado todavía. Avisa a la tienda.';
        case 'auth/network-request-failed':
            return 'Sin conexión. Revisa tu red e inténtalo de nuevo.';
        case 'auth/user-disabled':
            return 'Esta cuenta está desactivada. Contacta con la tienda.';
        case 'auth/account-exists-with-different-credential':
            return 'Ese email ya está registrado con otro método de acceso. Contacta con la tienda.';
        default:
            return `No se pudo iniciar sesión. Inténtalo de nuevo.${error?.code ? ` (${error.code})` : ''}`;
    }
}

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

$('googleBtn').addEventListener('click', async event => {
    showMessage(message, '');
    try {
        await withBusy(event.currentTarget, 'Abriendo Google…', () => signInWithPopup(auth, provider));
        await afterLogin();
    } catch (error) {
        // Cerrar la ventana de Google no es un error que haya que mostrar
        if (['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(error?.code)) return;
        console.error('Error al iniciar sesión con Google:', error);
        showMessage(message, googleErrorMessage(error), 'error');
    }
});

// Modo pruebas: sesión anónima real de Firebase (todo lo que cree queda marcado como prueba)
$('testLoginBtn').hidden = !TEST_MODE;
$('testLoginBtn').addEventListener('click', async event => {
    showMessage(message, '');
    try {
        await withBusy(event.currentTarget, 'Entrando…', () => signInAnonymously(auth));
        await afterLogin();
    } catch (error) {
        console.error('Error en el acceso de prueba:', error);
        showMessage(message, error?.code === 'auth/operation-not-allowed'
            ? 'El acceso anónimo de pruebas no está activado en Firebase (Authentication → Anónimo).'
            : googleErrorMessage(error), 'error');
    }
});

// ---------- Paso 2: alta o vinculación del teléfono ----------

async function afterLogin() {
    showStep('stepLoading');
    session = await getSession();
    if (!session) {
        if (IN_APP_BROWSER && !TEST_MODE) showInAppHelp();
        else showStep('stepSignIn');
        return;
    }

    try {
        profile = await getProfile(session.uid);
    } catch (error) {
        console.error('Error leyendo el expediente:', error);
        showStep('stepSignIn');
        showMessage(message, 'No hemos podido cargar tu cuenta. Inténtalo de nuevo en unos minutos.', 'error');
        return;
    }

    if (hasCompletedProfile(profile)) {
        goNext();
        return;
    }
    showProfileStep();
}

function showProfileStep() {
    const relinking = Boolean(profile); // ya tiene cuenta pero su teléfono fue liberado por el obrador
    document.querySelectorAll('[data-signup-only]').forEach(node => { node.hidden = relinking; });
    $('profileTitle').textContent = relinking ? 'Vincula tu teléfono' : 'Completa tu cuenta';
    $('profileDesc').textContent = relinking
        ? 'Tu cuenta no tiene un teléfono vinculado. Añádelo para seguir pidiendo.'
        : 'Necesitamos tu nombre y un teléfono para coordinar las entregas.';
    $('saveProfileBtn').textContent = relinking ? 'Vincular teléfono' : 'Crear mi cuenta';

    const saved = storage.get('pachoncito_user') || {};
    $('regName').value = session.user.displayName || saved.name || '';
    $('regAddress').value = saved.address || '';
    const storedInvite = String(storage.get('pachoncito_ref') || '');
    $('regInvite').value = REFERRAL_CODE.test(storedInvite) ? storedInvite : ''; // los enlaces antiguos llevaban un teléfono
    if (session.isTest) $('regPhone').placeholder = '600 000 123 (teléfono de prueba)';

    showStep('stepProfile');
    $(relinking ? 'regPhone' : 'regName').focus();
}

$('infoBtn').addEventListener('click', () => $('infoModal').showModal());
$('closeInfoBtn').addEventListener('click', () => $('infoModal').close());

// Código propio de invitación: 3 letras del nombre + 4 caracteres sin ambigüedades (sin 0/O, 1/I)
function makeReferralCode(name) {
    const letters = name.normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase().padEnd(3, 'X').slice(0, 3);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const random = crypto.getRandomValues(new Uint32Array(4));
    return `${letters}-${[...random].map(n => alphabet[n % alphabet.length]).join('')}`;
}

async function freeReferralCode(name) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = makeReferralCode(name);
        if (!(await getDoc(doc(db, 'referralCodes', code))).exists()) return code;
    }
    throw new Error('No se pudo generar un código de invitación libre');
}

function validatePhone() {
    const phone = normalizePhone($('regPhone').value);
    if (!phone) {
        showMessage(message, 'Introduce un teléfono válido (9 cifras o formato +34…).', 'error');
        $('regPhone').focus();
        return null;
    }
    if (session.isTest && !isTestPhone(phone)) {
        showMessage(message, `En la cuenta de prueba usa un teléfono de prueba: ${TEST_PHONES_LABEL}.`, 'error');
        $('regPhone').focus();
        return null;
    }
    return phone;
}

async function createAccount(button) {
    const name = $('regName').value.trim().replace(/\s+/g, ' ');
    const address = $('regAddress').value.trim();
    const invite = $('regInvite').value.trim().toUpperCase();

    if (name.length < 2) {
        showMessage(message, 'Escribe tu nombre para crear la cuenta.', 'error');
        $('regName').focus();
        return;
    }
    const phone = validatePhone();
    if (!phone) return;
    if (invite && !REFERRAL_CODE.test(invite)) {
        showMessage(message, 'El código de invitación tiene el formato ABC-1234.', 'error');
        return;
    }

    try {
        await withBusy(button, 'Creando tu cuenta…', async () => {
            if (invite) {
                const inviteSnap = await getDoc(doc(db, 'referralCodes', invite));
                if (!inviteSnap.exists() || inviteSnap.data().uid === session.uid) {
                    throw Object.assign(new Error('Código de invitación no válido'), { code: 'invalid-invite' });
                }
            }
            const referralCode = await freeReferralCode(name);

            // Un único lote: perfil + cerrojo del teléfono + código propio. Si el teléfono ya está
            // vinculado a otra cuenta, las reglas rechazan el lote entero.
            const batch = writeBatch(db);
            batch.set(doc(db, 'customers', session.uid), {
                name,
                email: session.user.email || '',
                phone,
                address,
                referralCode,
                ...(invite ? { referredByCode: invite } : {}),
                test: session.isTest,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            });
            batch.set(doc(db, 'phoneClaims', phone), { uid: session.uid, createdAt: serverTimestamp() });
            batch.set(doc(db, 'referralCodes', referralCode), { uid: session.uid });
            await batch.commit();
        });
    } catch (error) {
        console.error('Error creando la cuenta:', error);
        showMessage(message, error.code === 'invalid-invite'
            ? 'Ese código de invitación no existe. Revísalo o déjalo vacío.'
            : phoneTakenMessage(error), 'error');
        return;
    }

    storage.set('pachoncito_user', { name, phone, address });
    storage.remove('pachoncito_ref');
    showMessage(message, '');
    showWelcome();
}

async function relinkPhone(button) {
    const phone = validatePhone();
    if (!phone) return;
    try {
        await withBusy(button, 'Vinculando…', () => {
            const batch = writeBatch(db);
            batch.update(doc(db, 'customers', session.uid), { phone, updatedAt: serverTimestamp() });
            batch.set(doc(db, 'phoneClaims', phone), { uid: session.uid, createdAt: serverTimestamp() });
            return batch.commit();
        });
        goNext();
    } catch (error) {
        console.error('Error vinculando el teléfono:', error);
        showMessage(message, phoneTakenMessage(error), 'error');
    }
}

function phoneTakenMessage(error) {
    return error?.code === 'permission-denied'
        ? 'Ese teléfono ya está vinculado a otra cuenta. Si es tuyo, escríbenos por WhatsApp o Instagram y lo revisamos.'
        : 'No se pudo guardar. Revisa la conexión e inténtalo de nuevo.';
}

$('saveProfileBtn').addEventListener('click', event => {
    showMessage(message, '');
    if (profile) relinkPhone(event.currentTarget);
    else createAccount(event.currentTarget);
});

// ---------- Paso 3: bienvenida e invitación a instalar ----------

function showWelcome() {
    if (isStandalone()) {
        goNext();
        return;
    }
    $('continueBtn').textContent = next.startsWith('index.html') ? 'Hacer mi primer pedido' : 'Continuar';
    mountInstallPrompt($('installSlot'), { afterSignup: true });
    showStep('stepWelcome');
}

$('continueBtn').addEventListener('click', goNext);

$('logoutBtn').addEventListener('click', async () => {
    await endSession();
    session = null;
    profile = null;
    showMessage(message, '');
    showStep('stepSignIn');
});

// ---------- Inicio ----------

afterLogin();
