// Verificación por SMS con Firebase Auth (usada en acceso.html y resenas.html).
// Con números de prueba o emuladores no se envía ningún SMS, pero la sesión es real:
// el token lleva phone_number y las reglas de Firestore se aplican igual que en producción.
import { RecaptchaVerifier, signInWithPhoneNumber } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { EMULATORS, isTestPhone, TEST_MODE, TEST_OTP, USE_EMULATORS } from "./env.js";
import { firebaseConfig } from "./firebase.js";

// El emulador de Auth no envía SMS: expone los códigos generados en esta API local
async function fetchEmulatorCode(phone) {
    try {
        const response = await fetch(`${EMULATORS.authUrl}/emulator/v1/projects/${firebaseConfig.projectId}/verificationCodes`);
        const { verificationCodes = [] } = await response.json();
        return verificationCodes.filter(entry => entry.phoneNumber === phone).at(-1)?.code ?? null;
    } catch {
        return null;
    }
}

export function createPhoneLogin(auth, containerId) {
    let verifier = null;
    let verifierIsTest = false;
    let confirmation = null;

    function getVerifier(testing) {
        if (verifier && verifierIsTest !== testing) {
            verifier.clear();
            verifier = null;
        }
        // Sin reCAPTCHA para números de prueba y emuladores (Firebase solo lo acepta con números de prueba)
        auth.settings.appVerificationDisabledForTesting = testing;
        verifier ??= new RecaptchaVerifier(auth, containerId, { size: 'invisible' });
        verifierIsTest = testing;
        return verifier;
    }

    return {
        // Devuelve { suggestedCode } cuando el código se conoce de antemano (pruebas)
        async send(phone) {
            const testing = USE_EMULATORS || isTestPhone(phone);
            try {
                confirmation = await signInWithPhoneNumber(auth, phone, getVerifier(testing));
            } catch (error) {
                verifier?.clear();
                verifier = null;
                throw error;
            }
            if (USE_EMULATORS) return { suggestedCode: await fetchEmulatorCode(phone) };
            return { suggestedCode: TEST_MODE && isTestPhone(phone) ? TEST_OTP : null };
        },
        async confirm(code) {
            if (!confirmation) throw Object.assign(new Error('Sin código solicitado'), { code: 'auth/missing-verification-id' });
            return confirmation.confirm(code);
        }
    };
}

export function phoneAuthErrorMessage(error) {
    switch (error?.code) {
        case 'auth/invalid-phone-number': return 'El número de teléfono no es válido.';
        case 'auth/too-many-requests':
        case 'auth/quota-exceeded': return 'Demasiados intentos. Espera unos minutos y vuelve a probar.';
        case 'auth/invalid-verification-code': return 'El código no es correcto.';
        case 'auth/code-expired': return 'El código ha caducado. Solicita uno nuevo.';
        case 'auth/missing-verification-id': return 'Primero solicita el código SMS.';
        case 'auth/operation-not-allowed': return 'El acceso por SMS no está activado todavía.';
        case 'auth/network-request-failed': return USE_EMULATORS
            ? 'No hay conexión con el emulador de Auth. ¿Está arrancado (firebase emulators:start)?'
            : 'Sin conexión. Revisa tu red e inténtalo de nuevo.';
        default: return 'No se pudo completar la verificación. Inténtalo de nuevo.';
    }
}
