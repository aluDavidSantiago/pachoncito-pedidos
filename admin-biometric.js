// Desbloqueo biométrico del panel (Face ID / Touch ID / huella / Windows Hello) con WebAuthn.
//
// Cómo funciona y por qué: Firebase Auth no puede iniciar sesión con una credencial biométrica sin un
// servidor que la verifique (Cloud Functions, plan Blaze). Por eso, como en las apps bancarias, la sesión
// del obrador se abre UNA vez con contraseña y queda guardada en este dispositivo; a partir de ahí el panel
// se abre bloqueado y Face ID lo desbloquea (navigator.credentials.get con verificación de usuario obligatoria).
// Es un cerrojo local del dispositivo: la seguridad de los datos la siguen poniendo firestore.rules.
import { storage } from "./shared.js";

const ENROLLMENT_KEY = 'pachoncito_admin_biometric';
const DECLINED_KEY = 'pachoncito_admin_biometric_declined';
const UNLOCKED_KEY = 'pachoncito_admin_unlocked'; // por pestaña (sessionStorage)

const toBase64Url = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const randomChallenge = () => crypto.getRandomValues(new Uint8Array(32));

export async function biometricAvailable() {
    try {
        return Boolean(window.PublicKeyCredential)
            && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
        return false;
    }
}

export function biometricLabel() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(ua)) return 'Face ID';
    if (/Macintosh/i.test(ua)) return navigator.maxTouchPoints > 1 ? 'Face ID' : 'Touch ID';
    if (/Android/i.test(ua)) return 'tu huella';
    if (/Windows/i.test(ua)) return 'Windows Hello';
    return 'biometría';
}

export const getEnrollment = uid => {
    const enrollment = storage.get(ENROLLMENT_KEY);
    return enrollment?.uid === uid ? enrollment : null;
};

// Registra una credencial en el autenticador del propio dispositivo (Face ID, Touch ID…)
export async function enrollBiometric(user) {
    const credential = await navigator.credentials.create({
        publicKey: {
            challenge: randomChallenge(),
            rp: { name: 'Pachoncito · Obrador' },          // id = este dominio
            user: {
                id: new TextEncoder().encode(user.uid),
                name: user.email || 'obrador',
                displayName: 'Obrador Pachoncito'
            },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            authenticatorSelection: {
                authenticatorAttachment: 'platform',
                userVerification: 'required',
                residentKey: 'preferred'
            },
            // Pista para el sistema: la llave va en ESTE dispositivo (llavero del iPhone / iCloud), no en otro proveedor
            hints: ['client-device'],
            attestation: 'none',
            timeout: 60000
        }
    });
    storage.set(ENROLLMENT_KEY, { uid: user.uid, credentialId: toBase64Url(credential.rawId), createdAt: Date.now() });
    storage.remove(DECLINED_KEY);
    markUnlocked();
}

// Pide Face ID / Touch ID. Lanza un error si el usuario cancela o la verificación falla.
// Sin «allowCredentials»: el sistema ofrece cualquier llave del obrador guardada para este dominio. Así vale
// también la del iPad que el llavero de iCloud ha copiado al iPhone (antes solo se aceptaba la creada en este
// mismo dispositivo y, si esa se había guardado en Google o se había perdido, el iPhone decía «no tienes
// ninguna llave»). Se acepta si es la registrada aquí o si pertenece a la cuenta del obrador (userHandle = uid).
export async function verifyBiometric(enrollment) {
    const credential = await navigator.credentials.get({
        publicKey: {
            challenge: randomChallenge(),
            hints: ['client-device'],
            userVerification: 'required',
            timeout: 60000
        }
    });
    const handle = credential?.response?.userHandle;
    const owner = handle && handle.byteLength ? new TextDecoder().decode(handle) : null;
    const sameKey = credential && toBase64Url(credential.rawId) === enrollment.credentialId;
    if (!sameKey && owner !== enrollment.uid) {
        throw Object.assign(new Error('Llave de otra cuenta'), { name: 'WrongAccountError' });
    }
    if (!sameKey) storage.set(ENROLLMENT_KEY, { ...enrollment, credentialId: toBase64Url(credential.rawId) });
    markUnlocked();
}

export function forgetBiometric() {
    storage.remove(ENROLLMENT_KEY);
    lockPanel();
}

export const declineBiometricOffer = () => storage.set(DECLINED_KEY, Date.now());
export const clearBiometricDecline = () => storage.remove(DECLINED_KEY);
export const biometricOfferDeclined = () => Boolean(storage.get(DECLINED_KEY));

export function markUnlocked() {
    try { sessionStorage.setItem(UNLOCKED_KEY, '1'); } catch { /* sin almacenamiento */ }
}

export function lockPanel() {
    try { sessionStorage.removeItem(UNLOCKED_KEY); } catch { /* sin almacenamiento */ }
}

export function isUnlocked() {
    try { return sessionStorage.getItem(UNLOCKED_KEY) === '1'; } catch { return false; }
}

export function biometricErrorMessage(error) {
    switch (error?.name) {
        case 'NotAllowedError': return 'Verificación cancelada o no reconocida. Vuelve a intentarlo. Si el iPhone dice que no tienes ninguna llave, pulsa «Usar contraseña»: al entrar te ofrecerá activar Face ID de nuevo.';
        case 'WrongAccountError': return 'Esa llave no es la del obrador. Elige la de la cuenta del obrador o pulsa «Usar contraseña».';
        case 'InvalidStateError': return 'Este dispositivo ya tiene una credencial registrada para el panel.';
        case 'SecurityError': return 'El navegador no permite la biometría en esta dirección.';
        case 'NotSupportedError': return 'Este dispositivo no admite el acceso biométrico.';
        default: return 'No se pudo completar la verificación biométrica.';
    }
}
