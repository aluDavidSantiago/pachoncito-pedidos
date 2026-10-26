// Entorno de ejecución, emuladores y modo de pruebas.
// IMPORTANTE: TEST_PHONES debe coincidir con isTestPhone() de firestore.rules
// (+34 600 000 000 a +34 600 000 006 y +34 600 023 456).
import { el } from "./shared.js";

const params = new URLSearchParams(location.search);

// Interruptor que se activa con ?nombre=1, se apaga con ?nombre=0 y se recuerda mientras la pestaña esté abierta
function sessionFlag(param, fallback) {
    try {
        if (params.has(param)) sessionStorage.setItem(`pachoncito_${param}`, params.get(param) === '0' ? '0' : '1');
        const stored = sessionStorage.getItem(`pachoncito_${param}`);
        return stored === null ? fallback : stored === '1';
    } catch {
        return params.has(param) ? params.get(param) !== '0' : fallback;
    }
}

export const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

// Emuladores de Firebase (Auth + Firestore): solo en local y con ?emuladores=1
export const USE_EMULATORS = IS_LOCAL && sessionFlag('emuladores', false);

// Modo pruebas (aviso, código rellenado, reseñas de prueba visibles): siempre en local; en producción con ?pruebas=1
export const TEST_MODE = IS_LOCAL || sessionFlag('pruebas', false);

export const EMULATORS = {
    authUrl: 'http://127.0.0.1:9099',
    firestoreHost: '127.0.0.1',
    firestorePort: 8080
};

// Números ficticios: en producción hay que darlos de alta en Firebase Console →
// Authentication → Sign-in method → Teléfono → «Números de teléfono para pruebas», todos con TEST_OTP.
export const TEST_OTP = '123456';

export const TEST_CUSTOMERS = [
    { phone: '+34600000001', name: 'Ana Prueba' },
    { phone: '+34600000002', name: 'Bruno Prueba' },
    { phone: '+34600000003', name: 'Carla Prueba' },
    { phone: '+34600000004', name: 'Diego Prueba' },
    { phone: '+34600000005', name: 'Elena Prueba' },
    { phone: '+34600000006', name: 'Fran Prueba' },
    { phone: '+34600023456', name: 'Probador Pachoncito' }
];

// +34600000000 no lo usa el generador: queda libre para probar a mano como cliente nuevo
export const TEST_PHONES = ['+34600000000', ...TEST_CUSTOMERS.map(customer => customer.phone)];
export const TEST_PHONES_LABEL = '+34 600 000 000–006 o +34 600 023 456';

export const isTestPhone = phone => TEST_PHONES.includes(phone);

export function mountEnvBanner() {
    if (!TEST_MODE) return;
    const target = USE_EMULATORS ? 'emuladores locales' : 'Firebase real';
    document.body.classList.add('has-env-banner');
    document.body.prepend(el('div', { className: 'env-banner', role: 'note' },
        el('strong', { text: `🧪 Modo pruebas · ${target}` }),
        ` · Teléfonos ${TEST_PHONES_LABEL} · código ${TEST_OTP}`
    ));
}
