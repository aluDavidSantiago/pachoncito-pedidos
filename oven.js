// Capacidad del horno por franja de entrega (compartido por la carta y el panel).
//
// El horno saca `traysPerHour` bandejas de `unitsPerTray` pandebonos por hora: en cada franja de 30 min,
// la mitad. Un pedido para las 10:00 puede hornearse en su franja (09:30–10:00) o en las anteriores, pero como
// mucho `freshHours` horas antes, para que llegue recién hecho. Con la carga de cada franja se comprueba si
// todo cabe (planificación «primero lo que vence antes»): la carta solo ofrece las horas en las que el pedido cabe.
//
// La carga vive en ovenLoad/{domingo} = { units: { '10:00': 12, … } }: pública (solo números, sin datos
// personales). La suma cada pedido nuevo en el mismo lote (firestore.rules lo comprueba) y el panel la recalcula
// con los pedidos reales cada vez que cambian.
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export const OVEN_DEFAULTS = { traysPerHour: 2, unitsPerTray: 16, freshHours: 2 };

// Franjas de 30 minutos entre 06:00 y 17:30 (las mismas que valida firestore.rules)
export const SLOTS = Array.from({ length: 24 }, (_, i) => {
    const minutes = 6 * 60 + i * 30;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${minutes % 60 === 0 ? '00' : '30'}`;
});

const clampInt = (value, min, max, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// Ajustes del horno guardados en settings/store (el panel los cambia)
export function ovenConfig(store = {}) {
    const traysPerHour = clampInt(store.ovenTraysPerHour, 1, 12, OVEN_DEFAULTS.traysPerHour);
    const unitsPerTray = clampInt(store.ovenUnitsPerTray, 1, 100, OVEN_DEFAULTS.unitsPerTray);
    const freshHours = clampInt(store.ovenFreshHours, 1, 12, OVEN_DEFAULTS.freshHours);
    return { traysPerHour, unitsPerTray, freshHours, perSlot: traysPerHour * unitsPerTray / 2, windowSlots: freshHours * 2 };
}

// Pandebonos que hay que hornear para un pedido: los pedidos, las ñapas por volumen, el regalo y las ñapas canjeadas
export function orderUnits(order) {
    return (order.items?.clasico || 0) + (order.items?.bocadillo || 0) + (order.napaCount || 0)
        + (order.welcomeGift ? 1 : 0) + (Number.isInteger(order.creditsToRedeem) ? order.creditsToRedeem : 0);
}

// ¿Cabe toda la carga en el horno? Recorre las franjas en orden y hornea primero lo que se entrega antes.
export function fits(load, cfg) {
    const queue = []; // [franja límite, pendiente]
    for (let t = 0; t < SLOTS.length; t++) {
        // Entran los pedidos que ya se pueden empezar a hornear en esta franja
        SLOTS.forEach((slot, d) => {
            const units = load[slot] || 0;
            if (units > 0 && Math.max(0, d - cfg.windowSlots + 1) === t) queue.push([d, units]);
        });
        queue.sort((a, b) => a[0] - b[0]);
        let capacity = cfg.perSlot;
        for (const job of queue) {
            if (capacity <= 0) break;
            const baked = Math.min(capacity, job[1]);
            job[1] -= baked;
            capacity -= baked;
        }
        if (queue.some(job => job[0] === t && job[1] > 0)) return false;
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i][1] <= 0) queue.splice(i, 1);
    }
    return true;
}

export const addUnits = (load, slot, units) => ({ ...load, [slot]: (load[slot] || 0) + units });

// Franjas en las que cabe un pedido de `units` pandebonos con la carga actual
export function slotsFor(load, units, cfg) {
    return SLOTS.map(slot => ({ slot, fits: units <= 0 || fits(addUnits(load, slot, units), cfg) }));
}

// Máximo que cabe en una franja si el resto del día estuviera vacío
export const maxPerOrder = cfg => cfg.perSlot * cfg.windowSlots;

// Domingo de entrega de un pedido hecho ahora (igual que el panel): el próximo domingo; los domingos, el siguiente
export function sundayKeyFor(date = new Date()) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + (d.getDay() === 0 ? 7 : 7 - d.getDay()));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const ovenLoadRef = (db, day) => doc(db, 'ovenLoad', day);

// Carga del horno en directo (sin documento = vacío). Si no se puede leer (reglas antiguas), se trata como vacío.
export function watchOvenLoad(db, day, onChange) {
    return onSnapshot(ovenLoadRef(db, day), snap => onChange(snap.data()?.units || {}), error => {
        console.warn('No se pudo leer la carga del horno:', error);
        onChange({});
    });
}

// Carga real de cada domingo a partir de los pedidos (el panel la usa para corregir ovenLoad)
export function loadFromOrders(orders, sundayOf) {
    const byDay = new Map();
    for (const order of orders) {
        if (order.status === 'rejected' || !order.deliverySlot) continue;
        const day = sundayOf(order);
        const load = byDay.get(day) || {};
        load[order.deliverySlot] = (load[order.deliverySlot] || 0) + orderUnits(order);
        byDay.set(day, load);
    }
    return byDay;
}

// Plan de hornadas para el obrador: hornea cada pedido lo MÁS TARDE posible (más fresco) sin pasarse de la capacidad.
// Devuelve, por franja de producción, lo que se hornea y para qué hora; y lo que no cabe (faltan).
export function bakePlan(load, cfg) {
    const n = SLOTS.length;
    const remaining = SLOTS.map(slot => load[slot] || 0);
    const plan = SLOTS.map(() => ({ total: 0, parts: [] }));
    // Del final al principio: en cada franja, primero lo que se entrega más tarde y ya se puede hornear
    for (let t = n - 1; t >= 0; t--) {
        let capacity = cfg.perSlot;
        for (let d = Math.min(n - 1, t + cfg.windowSlots - 1); d >= t && capacity > 0; d--) {
            if (!remaining[d]) continue;
            const baked = Math.min(capacity, remaining[d]);
            remaining[d] -= baked;
            capacity -= baked;
            plan[t].total += baked;
            plan[t].parts.push({ slot: SLOTS[d], units: baked });
        }
    }
    const missing = SLOTS.map((slot, i) => ({ slot, units: remaining[i] })).filter(m => m.units > 0);
    return { plan, missing };
}

// «10:00» → «09:30»: la hornada de una franja empieza media hora antes
export function bakeStart(slot) {
    const [h, m] = slot.split(':').map(Number);
    const t = h * 60 + m - 30;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
