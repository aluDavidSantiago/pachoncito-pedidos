// Reglas de negocio y utilidades compartidas.
// IMPORTANTE: los precios y la regla de ñapas también están en firestore.rules; si cambian aquí, cámbialos allí.

// Versión visible en el pie de todas las páginas (ui.js · mountVersion). Al cambiarla, sube también CACHE_VERSION en sw.js.
export const APP_VERSION = '2.3.0';

export const PRICES_CENTS = { clasico: 150, bocadillo: 170 };
export const DELIVERY_CENTS = 100;
export const NAPA_EVERY_CENTS = 1000; // 1 ñapa por cada 10 € (envío incluido)
export const MAX_QTY = 200;

export const PRODUCT_NAMES = {
    clasico: 'Clásico',
    bocadillo: 'Con Bocadillo (Guayaba)'
};

// Canales de atención al cliente. whatsapp: número en formato internacional sin "+" ni espacios
// (p. ej. '34600123456'); si se deja vacío, el botón de WhatsApp no se muestra.
export const CONTACT = {
    instagram: 'pachoncito_oficial',
    whatsapp: ''
};

export const RATING_ASPECTS = [
    ['producto', 'Producto'],
    ['entrega', 'Entrega'],
    ['atencion', 'Atención']
];

const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
export const formatEUR = cents => eur.format(cents / 100);

export function formatDate(timestamp) {
    if (!timestamp?.toDate) return '';
    return timestamp.toDate().toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
}

export function starsText(value) {
    const n = Math.max(0, Math.min(5, Math.round(value || 0)));
    return '★'.repeat(n) + '☆'.repeat(5 - n);
}

// Devuelve el teléfono en formato E.164 (+34600000000) o null si no es válido.
// Se usa como identificador de cliente y como código de referido.
export function normalizePhone(raw) {
    if (!raw) return null;
    let phone = String(raw).replace(/[\s\-.()]/g, '');
    if (phone.startsWith('00')) phone = '+' + phone.slice(2);
    if (/^[6789]\d{8}$/.test(phone)) phone = '+34' + phone;
    return /^\+\d{8,15}$/.test(phone) ? phone : null;
}

// Validación estructural de un móvil español, sin SMS: 9 cifras, prefijo móvil real (6 o 71–74) y sin
// patrones de número inventado. Las reglas de Firestore repiten el formato y los patrones (isRealMobile).
// Devuelve { phone: '+34…' } si es válido, o { error, incomplete } con el motivo para mostrarlo al momento.
const SEQUENCES = ['0123456789', '9876543210'];

export function phoneDigits(raw) {
    let digits = String(raw || '').replace(/\D/g, '');
    if (digits.length > 9 && digits.startsWith('0034')) digits = digits.slice(4);
    else if (digits.length > 9 && digits.startsWith('34')) digits = digits.slice(2);
    return digits;
}

export function validateMobile(raw) {
    const digits = phoneDigits(raw);
    if (!digits) return { error: 'Escribe tu móvil.', incomplete: true };
    if (!/^[67]/.test(digits)) return { error: 'Debe ser un móvil español: empieza por 6 o 7.' };
    if (digits.length < 9) return { error: `Faltan ${9 - digits.length} ${9 - digits.length === 1 ? 'cifra' : 'cifras'}.`, incomplete: true };
    if (digits.length > 9) return { error: 'Tiene más de 9 cifras.' };
    if (/^7[05-9]/.test(digits)) return { error: 'Los móviles que empiezan por 7 van del 71 al 74.' };
    if (/(\d)\1{4}/.test(digits)) return { error: 'Tiene demasiadas cifras iguales seguidas.' };
    if (new Set(digits).size < 3) return { error: 'No parece un número real: revisa las cifras.' };
    for (let i = 0; i + 6 <= digits.length; i++) {
        const chunk = digits.slice(i, i + 6);
        if (SEQUENCES.some(seq => seq.includes(chunk))) return { error: 'Contiene una secuencia (123456…): revisa el número.' };
    }
    return { phone: `+34${digits}` };
}

// «612345678» → «612 345 678» (máscara de entrada)
export const formatMobile = digits => digits.slice(0, 9).replace(/^(\d{3})(\d{1,3})?(\d{1,3})?$/, (_, a, b, c) => [a, b, c].filter(Boolean).join(' '));

// Crea elementos del DOM de forma segura: todo el texto entra como textContent, nunca como HTML.
export function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
        if (child == null || child === false) continue;
        node.append(child instanceof Node ? child : String(child));
    }
    return node;
}

export function showMessage(node, text, type = 'info') {
    node.textContent = text || '';
    node.dataset.type = type;
    node.hidden = !text;
}

export async function withBusy(button, busyText, task) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    try {
        return await task();
    } finally {
        button.disabled = false;
        button.textContent = label;
    }
}

export const storage = {
    get(key) {
        try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* almacenamiento no disponible */ }
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch { /* almacenamiento no disponible */ }
    }
};
