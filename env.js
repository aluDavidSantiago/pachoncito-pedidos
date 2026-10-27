// Entorno de ejecución, emuladores y modo de pruebas.
// IMPORTANTE: isTestPhone() debe coincidir con la función del mismo nombre en firestore.rules.
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

// Emuladores de Firebase (Auth + Firestore): solo en local y con ?emuladores=1.
// El emulador de Auth muestra cuentas de Google ficticias: no hace falta ninguna cuenta real.
export const USE_EMULATORS = IS_LOCAL && sessionFlag('emuladores', false);

// Modo pruebas: muestra «Entrar como cliente de prueba» (sesión anónima) y las reseñas de prueba.
// Siempre activo en local; en producción con ?pruebas=1 (y ?pruebas=0 para salir).
export const TEST_MODE = IS_LOCAL || sessionFlag('pruebas', false);

export const EMULATORS = {
    authUrl: 'http://127.0.0.1:9099',
    firestoreHost: '127.0.0.1',
    firestorePort: 8080
};

// Teléfonos ficticios para cuentas de prueba: +34 600 000 000 a +34 600 000 999 y +34 600 023 456.
// Los clientes de prueba (sesión anónima) solo pueden vincular estos números.
export const isTestPhone = phone => typeof phone === 'string' && /^\+34600(000\d{3}|023456)$/.test(phone);
export const TEST_PHONES_LABEL = '+34 600 000 000–999 o +34 600 023 456';

// Clientes que crea el generador de datos del panel (UID ficticio "seed_*")
export const TEST_CUSTOMERS = [
    { uid: 'seed_ana', name: 'Ana Prueba', phone: '+34600000001', referralCode: 'ANA-TEST' },
    { uid: 'seed_bruno', name: 'Bruno Prueba', phone: '+34600000002', referralCode: 'BRU-TEST' },
    { uid: 'seed_carla', name: 'Carla Prueba', phone: '+34600000003', referralCode: 'CAR-TEST' },
    { uid: 'seed_diego', name: 'Diego Prueba', phone: '+34600000004', referralCode: 'DIE-TEST' },
    { uid: 'seed_elena', name: 'Elena Prueba', phone: '+34600000005', referralCode: 'ELE-TEST' },
    { uid: 'seed_fran', name: 'Fran Prueba', phone: '+34600000006', referralCode: 'FRA-TEST' },
    { uid: 'seed_probador', name: 'Probador Pachoncito', phone: '+34600023456', referralCode: 'PRO-TEST' }
];

export function mountEnvBanner() {
    if (!TEST_MODE) return;
    const target = USE_EMULATORS ? 'emuladores locales' : 'Firebase real';
    document.body.classList.add('has-env-banner');
    document.body.prepend(el('div', { className: 'env-banner', role: 'note' },
        el('strong', { text: `🧪 Modo pruebas · ${target}` }),
        ` · Entra como cliente de prueba y usa teléfonos ${TEST_PHONES_LABEL}`
    ));
}
