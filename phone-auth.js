// Verificación por SMS con Firebase Auth (usada en acceso.html y resenas.html)
import { RecaptchaVerifier, signInWithPhoneNumber } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

export function createPhoneLogin(auth, containerId) {
    let verifier = null;
    let confirmation = null;

    return {
        async send(phone) {
            verifier ??= new RecaptchaVerifier(auth, containerId, { size: 'invisible' });
            try {
                confirmation = await signInWithPhoneNumber(auth, phone, verifier);
            } catch (error) {
                verifier.clear();
                verifier = null;
                throw error;
            }
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
        default: return 'No se pudo completar la verificación. Inténtalo de nuevo.';
    }
}
