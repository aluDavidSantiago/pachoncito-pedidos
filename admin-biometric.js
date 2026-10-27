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
                residentKey: 'discouraged'
            },
            attestation: 'none',
            timeout: 60000
        }
    });
    storage.set(ENROLLMENT_KEY, { uid: user.uid, credentialId: toBase64Url(credential.rawId), createdAt: Date.now() });
    storage.remove(DECLINED_KEY);
    markUnlocked();
}

// Pide Face ID / Touch ID. Lanza un error si el usuario cancela o la verificación falla.
export async function verifyBiometric(enrollment) {
    await navigator.credentials.get({
        publicKey: {
            challenge: randomChallenge(),
            allowCredentials: [{ type: 'public-key', id: fromBase64Url(enrollment.credentialId), transports: ['internal'] }],
            userVerification: 'required',
            timeout: 60000
        }
    });
    markUnlocked();
}

export function forgetBiometric() {
    storage.remove(ENROLLMENT_KEY);
    lockPanel();
}

export const declineBiometricOffer = () => storage.set(DECLINED_KEY, Date.now());
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
        case 'NotAllowedError': return 'Verificación cancelada o no reconocida. Vuelve a intentarlo.';
        case 'InvalidStateError': return 'Este dispositivo ya tiene una credencial registrada para el panel.';
        case 'SecurityError': return 'El navegador no permite la biometría en esta dirección.';
        case 'NotSupportedError': return 'Este dispositivo no admite el acceso biométrico.';
        default: return 'No se pudo completar la verificación biométrica.';
    }
}
