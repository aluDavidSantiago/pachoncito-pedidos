// Reparto en directo desde el panel del obrador (solo lógica; el estado de los pedidos llega de admin.js).
//
// «Salgo a repartir»: los pedidos a domicilio elegidos pasan a «En reparto» y por cada uno se crea tracking/{idPedido}
// con su destino. Mientras tanto, este móvil envía su posición (watchPosition) a esos documentos y, cada minuto,
// el tiempo estimado de llegada a cada dirección (OSRM, o en línea recta si falla).
// Al entregar un pedido o al terminar el reparto, su tracking se BORRA: la ubicación solo existe durante el reparto
// y cada cliente solo puede leer la de su pedido (firestore.rules · tracking).
//
// Servicios externos gratuitos, llamados SOLO desde este móvil (nunca desde los clientes):
//   · Nominatim (OpenStreetMap), y Photon si Nominatim no la encuentra: sitúan cada dirección una sola vez al salir.
//   · OSRM (demo pública): ruta y tiempo en coche hasta cada dirección, una vez por minuto (máx. 1 consulta por segundo).
import {
    deleteDoc, doc, serverTimestamp, updateDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { distanceMeters, formatDistance, formatMinutes, isPoint, straightLineEtaSeconds } from "./geo.js";
import { icon } from "./icons.js";
import { el, withBusy } from "./shared.js";

const SEND_EVERY_MS = 8000;        // como mucho, una posición cada 8 s…
const SEND_MIN_MOVE_M = 10;        // …y solo si se ha movido 10 m
const HEARTBEAT_MS = 30000;        // parado: se reenvía cada 30 s para que el cliente sepa que sigue conectado
const ETA_EVERY_MS = 60000;        // tiempo estimado: una consulta a OSRM por minuto
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const PHOTON_URL = 'https://photon.komoot.io/api/';
const TOWN = 'Premià de Mar';
const TOWN_CENTER = { lat: 41.4917, lng: 2.3606 };
const MAX_KM_FROM_TOWN = 15;       // un resultado más lejos es otro pueblo con una calle igual: se descarta
// Caja aproximada de Premià de Mar y alrededores: da preferencia a resultados de la zona
const VIEWBOX = '2.30,41.54,2.42,41.46';

// Tipos de vía en castellano → catalán (en OpenStreetMap las calles de Premià están en catalán)
const STREET_TYPES = [
    [/^(c\/|c\.|cl\.?|calle)\s+/i, 'Carrer '], [/^(avda\.?|av\.?|avenida)\s+/i, 'Avinguda '], [/^(pza\.?|pl\.?|plaza)\s+/i, 'Plaça '],
    [/^(pº|p\.º|paseo)\s+/i, 'Passeig '], [/^(camino)\s+/i, 'Camí '], [/^(pasaje|pje\.?)\s+/i, 'Passatge '], [/^(travesía|travesia)\s+/i, 'Travessera '],
    [/^(carretera|ctra\.?)\s+/i, 'Carretera '], [/^(rambla)\s+/i, 'Rambla '], [/^(ronda)\s+/i, 'Ronda ']
];

const OPEN_FOR_DELIVERY = ['pending', 'preparing', 'ready'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createDelivery({ db, root, onDeliver, toast }) {
    let allOrders = [];
    let sundayOrders = [];
    const selected = new Map();     // id → marcado en la lista de «Salgo a repartir» (por defecto sí)
    let watchId = null;
    let wakeLock = null;
    let position = null;            // { lat, lng, accuracy, at }
    let lastSent = null;            // { lat, lng, at }
    let lastEtaAt = 0;
    let etas = new Map();           // id → { seconds, distance, method }
    let gpsError = '';
    let sending = false;
    let hiddenSince = null;

    const active = () => allOrders.filter(o => o.status === 'delivering');
    const candidates = () => sundayOrders.filter(o => o.deliveryMethod === 'domicilio' && OPEN_FOR_DELIVERY.includes(o.status));
    const watching = () => watchId !== null;

    // ---------- Direcciones (Nominatim y Photon) ----------

    // «Calle Mayor 12, 2º 1ª» o «Calle Mayor, 12, bajos» → { street: 'Calle Mayor', number: '12' }
    function parseAddress(raw) {
        const parts = String(raw || '').split(',').map(part => part.trim()).filter(Boolean);
        let text = parts[0] || '';
        // Número después de la coma: «Calle Mayor, 12»
        const numberAfter = parts[1]?.match(/^(?:n[ºo°.]?\s*)?(\d+[a-z]?)\b/i);
        if (numberAfter && !/\d/.test(text)) text += ` ${numberAfter[1]}`;
        text = text
            .replace(/\b(piso|planta|puerta|pta\.?|esc\.?|escalera|bajos?|ático|atico|entresuelo|principal)\b.*$/i, '')
            .replace(/(\d+[a-z]?)\s+\d+\s*[ºª°].*$/i, '$1')
            .replace(/\s+/g, ' ')
            .trim();
        const match = text.match(/^(.*?)[\s,]+(?:n[ºo°.]?\s*)?(\d+[a-z]?)$/i) || text.match(/^(.*?)[\s,]+(?:n[ºo°.]?\s*)?(\d+[a-z]?)\b/i);
        return match ? { street: match[1].trim(), number: match[2] } : { street: text, number: '' };
    }

    function catalanStreet(street) {
        if (/^(carrer|avinguda|plaça|passeig|camí|passatge|travessera|carretera|rambla|ronda|via|riera)\b/i.test(street)) return street;
        for (const [pattern, replacement] of STREET_TYPES) {
            if (pattern.test(street)) return street.replace(pattern, replacement);
        }
        return `Carrer ${street}`;
    }

    const nearTown = point => point && distanceMeters(point, TOWN_CENTER) <= MAX_KM_FROM_TOWN * 1000;

    async function nominatim(params) {
        const url = `${NOMINATIM_URL}?format=jsonv2&limit=1&countrycodes=es&accept-language=es&viewbox=${VIEWBOX}&${params}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const [hit] = await response.json();
        const point = hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
        return nearTown(point) ? point : null;
    }

    async function photon(query) {
        const url = `${PHOTON_URL}?limit=1&lat=${TOWN_CENTER.lat}&lon=${TOWN_CENTER.lng}&q=${encodeURIComponent(query)}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        const [hit] = (await response.json()).features || [];
        const [lng, lat] = hit?.geometry?.coordinates || [];
        const point = Number.isFinite(lat) ? { lat, lng } : null;
        return nearTown(point) ? point : null;
    }

    // Prueba de más exacta a menos: con número y sin él, en castellano y en catalán; si nada, Photon.
    // Sin número se sitúa la calle (aproximado, pero suficiente para el tiempo de llegada).
    async function geocode(address) {
        const { street, number } = parseAddress(address);
        if (!street) return null;
        const names = [...new Set([street, catalanStreet(street)])];
        const attempts = [];
        for (const name of names) {
            if (number) attempts.push(() => nominatim(`street=${encodeURIComponent(`${number} ${name}`)}&city=${encodeURIComponent(TOWN)}`));
        }
        for (const name of names) attempts.push(() => nominatim(`street=${encodeURIComponent(name)}&city=${encodeURIComponent(TOWN)}`));
        attempts.push(() => nominatim(`q=${encodeURIComponent(`${address}, ${TOWN}`)}`));
        for (const name of names) attempts.push(() => photon(`${name} ${number}, ${TOWN}`.replace(/\s+,/, ',')));

        for (let i = 0; i < attempts.length; i++) {
            if (i) await sleep(1100); // Nominatim: máximo una consulta por segundo
            try {
                const point = await attempts[i]();
                if (point) return point;
            } catch (error) {
                console.warn('Búsqueda de dirección fallida:', error);
            }
        }
        return null;
    }

    // ---------- Ruta y tiempo estimado (OSRM, o línea recta) ----------

    // Una ruta por pedido (geometría para dibujarla en el mapa del cliente), espaciadas 1 s entre sí
    async function computeEtas(from, stops) {
        const result = new Map();
        const located = stops.filter(o => isPoint(o.destination));
        for (let i = 0; i < located.length; i++) {
            const order = located[i];
            if (i) await sleep(1100);
            try {
                const coords = [from, order.destination].map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 8000);
                const response = await fetch(`${OSRM_URL}${coords}?overview=simplified&geometries=polyline&alternatives=false&steps=false`, { signal: controller.signal });
                clearTimeout(timer);
                const data = await response.json();
                const route = data.routes?.[0];
                if (data.code !== 'Ok' || !route) throw new Error(data.code || 'OSRM');
                result.set(order.id, { seconds: Math.round(route.duration), distance: Math.round(route.distance), method: 'osrm', route: route.geometry || null });
            } catch (error) {
                console.warn('OSRM no disponible; se estima en línea recta:', error);
                result.set(order.id, {
                    seconds: straightLineEtaSeconds(from, order.destination),
                    distance: Math.round(distanceMeters(from, order.destination)),
                    method: 'linea',
                    route: null
                });
            }
        }
        return result;
    }

    // ---------- Envío de la posición ----------

    async function send(force = false) {
        const stops = active();
        if (!position || !stops.length || sending) return;
        const now = Date.now();
        const moved = lastSent ? distanceMeters(lastSent, position) : Infinity;
        const elapsed = lastSent ? now - lastSent.at : Infinity;
        if (!force && !(elapsed >= SEND_EVERY_MS && moved >= SEND_MIN_MOVE_M) && elapsed < HEARTBEAT_MS) return;

        sending = true;
        try {
            const courier = { lat: position.lat, lng: position.lng, accuracy: Math.round(position.accuracy || 0) };
            let etaUpdate = null;
            if (force || now - lastEtaAt >= ETA_EVERY_MS) {
                etas = await computeEtas(courier, stops);
                lastEtaAt = now;
                etaUpdate = etas;
            }
            // Uno a uno: si un pedido se acaba de entregar (su tracking ya no existe), los demás se actualizan igual
            await Promise.allSettled(stops.map(order => updateDoc(doc(db, 'tracking', order.id), {
                courier,
                updatedAt: serverTimestamp(),
                ...(etaUpdate?.has(order.id) ? (({ route, ...eta }) => ({ eta, route, etaAt: serverTimestamp() }))(etaUpdate.get(order.id)) : {})
            })));
            lastSent = { lat: courier.lat, lng: courier.lng, at: now };
        } catch (error) {
            console.error('Error al enviar la ubicación:', error);
        } finally {
            sending = false;
            render();
        }
    }

    function onPosition(pos) {
        gpsError = '';
        position = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, at: Date.now() };
        send();
    }

    function onGpsError(error) {
        gpsError = {
            1: 'Sin permiso de ubicación. Actívalo para este sitio en los ajustes del navegador.',
            2: 'No se encuentra la señal GPS. Sal a cielo abierto o revisa que la ubicación esté activada.',
            3: 'El GPS tarda en responder. Seguimos intentándolo…'
        }[error.code] || 'Error de ubicación.';
        if (error.code === 1) stopWatching();
        render();
    }

    async function keepScreenOn() {
        try {
            if ('wakeLock' in navigator && document.visibilityState === 'visible') {
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', () => { wakeLock = null; render(); });
            }
        } catch (error) {
            console.warn('No se pudo mantener la pantalla encendida:', error);
        }
        render();
    }

    let heartbeat = null;

    function startWatching() {
        if (!('geolocation' in navigator)) {
            gpsError = 'Este navegador no puede compartir la ubicación.';
            render();
            return false;
        }
        if (watching()) return true;
        watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
        heartbeat = setInterval(() => { send(); render(); }, 10000);
        keepScreenOn();
        return true;
    }

    function stopWatching() {
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        watchId = null;
        clearInterval(heartbeat);
        heartbeat = null;
        wakeLock?.release().catch(() => {});
        wakeLock = null;
        lastSent = null;
        lastEtaAt = 0;
    }

    // Con la pantalla apagada o en otra app, el móvil deja de dar la ubicación: al volver se reactiva todo
    document.addEventListener('visibilitychange', () => {
        if (!watching()) return;
        if (document.visibilityState === 'hidden') {
            hiddenSince = Date.now();
            return;
        }
        if (hiddenSince && Date.now() - hiddenSince > 20000) {
            toast('Mientras la pantalla estuvo apagada no se envió tu ubicación. Ya vuelve a enviarse.', 'info');
        }
        hiddenSince = null;
        keepScreenOn();
        send(true);
    });

    // ---------- Acciones ----------

    async function startRun(button) {
        const chosen = candidates().filter(o => selected.get(o.id) !== false);
        if (!chosen.length) {
            toast('Marca al menos un pedido para salir a repartir.', 'info');
            return;
        }
        if (!startWatching()) return;
        await withBusy(button, 'Situando direcciones…', async () => {
            let lookups = 0;
            for (const order of chosen) {
                if (isPoint(order.destination)) continue;
                if (lookups++) await sleep(1100); // Nominatim: máximo una consulta por segundo
                const point = await geocode(order.address);
                order.destination = point;
                if (point) await updateDoc(doc(db, 'orders', order.id), { destination: point });
            }
            const batch = writeBatch(db);
            for (const order of chosen) {
                batch.update(doc(db, 'orders', order.id), { status: 'delivering', deliveringAt: serverTimestamp() });
                batch.set(doc(db, 'tracking', order.id), {
                    destination: isPoint(order.destination) ? order.destination : null,
                    courier: position ? { lat: position.lat, lng: position.lng, accuracy: Math.round(position.accuracy || 0) } : null,
                    startedAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                });
            }
            await batch.commit();
            const lost = chosen.filter(o => !isPoint(o.destination)).length;
            toast(`En reparto: ${chosen.length} ${chosen.length === 1 ? 'pedido' : 'pedidos'}.`
                + (lost ? ` ${lost} sin situar en el mapa: verán tu posición, pero no el tiempo de llegada.` : ''), lost ? 'info' : 'success');
        }).catch(error => {
            console.error('Error al salir a repartir:', error);
            toast('No se pudo empezar el reparto. Revisa la conexión y vuelve a intentarlo.', 'error');
        });
        lastEtaAt = 0;
        setTimeout(() => send(true), 1500); // primera posición y primer tiempo estimado en cuanto llegue el snapshot
    }

    async function endRun(button) {
        const stops = active();
        const ok = !stops.length || confirm(`¿Terminar el reparto?\n\nDejarás de compartir tu ubicación. `
            + `${stops.length === 1 ? 'El pedido sin entregar vuelve' : `Los ${stops.length} pedidos sin entregar vuelven`} a «Listo».`);
        if (!ok) return;
        await withBusy(button, 'Terminando…', async () => {
            stopWatching();
            const batch = writeBatch(db);
            for (const order of stops) {
                batch.update(doc(db, 'orders', order.id), { status: 'ready' });
                batch.delete(doc(db, 'tracking', order.id));
            }
            await batch.commit();
            toast('Reparto terminado. Tu ubicación ya no se comparte.', 'success');
        }).catch(error => {
            console.error('Error al terminar el reparto:', error);
            toast('No se pudo terminar el reparto. Vuelve a intentarlo.', 'error');
        });
        render();
    }

    // Borra el seguimiento de un pedido (entregado, cancelado o borrado). Si no quedan pedidos, deja de enviar.
    async function forget(orderId) {
        try {
            await deleteDoc(doc(db, 'tracking', orderId));
        } catch (error) {
            console.error('Error al borrar el seguimiento:', error);
        }
        etas.delete(orderId);
        if (!active().some(o => o.id !== orderId)) {
            stopWatching();
            toast('No quedan pedidos en reparto: tu ubicación ya no se comparte.', 'success');
        }
        render();
    }

    // ---------- Interfaz ----------

    function gpsCard(stops) {
        if (!watching()) {
            return el('div', { className: 'delivery-gps is-off' },
                el('div', { className: 'delivery-gps-text' },
                    el('strong', { text: 'Este móvil no está enviando tu ubicación' }),
                    el('span', { className: 'hint', text: gpsError || 'Hay pedidos en reparto. Reanuda para que los clientes vean dónde estás.' })),
                el('button', { type: 'button', className: 'btn btn-primary btn-small', onClick: () => { startWatching(); send(true); } }, 'Reanudar ubicación'));
        }
        const ago = lastSent ? Math.round((Date.now() - lastSent.at) / 1000) : null;
        const detail = gpsError
            || (position ? `Última posición enviada ${ago === null ? '…' : `hace ${ago} s`} · precisión ±${Math.round(position.accuracy)} m` : 'Buscando señal GPS…');
        return el('div', { className: `delivery-gps${gpsError ? ' is-warning' : ''}` },
            el('span', { className: 'delivery-gps-dot', 'aria-hidden': 'true' }),
            el('div', { className: 'delivery-gps-text' },
                el('strong', { text: `Compartiendo tu ubicación con ${stops.length} ${stops.length === 1 ? 'cliente' : 'clientes'}` }),
                el('span', { className: 'hint', text: detail }),
                el('span', { className: 'hint', text: wakeLock ? 'Pantalla siempre encendida mientras repartes.' : 'No bloquees el móvil: con la pantalla apagada se deja de enviar.' })));
    }

    function stopCard(order) {
        const eta = etas.get(order.id);
        const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(isPoint(order.destination)
            ? `${order.destination.lat},${order.destination.lng}` : `${order.address}, ${TOWN}`)}`;
        return el('li', { className: 'delivery-stop' },
            el('div', { className: 'delivery-stop-head' },
                el('strong', { text: order.customerName || 'Sin nombre' }),
                el('span', { className: 'delivery-eta', text: eta ? `~${formatMinutes(eta.seconds)} · ${formatDistance(eta.distance)}` : (isPoint(order.destination) ? 'Calculando…' : 'Sin situar') })),
            el('span', { className: 'hint', text: `${order.address} · ${order.deliverySlot || '—'}` }),
            !isPoint(order.destination)
                ? el('span', { className: 'meta-accent', text: 'Dirección no encontrada en el mapa: el cliente ve tu posición, pero no el tiempo de llegada.' })
                : null,
            el('div', { className: 'actions-bar' },
                el('a', { className: 'btn btn-secondary btn-small', href: mapsUrl, target: '_blank', rel: 'noopener' }, icon('route'), 'Cómo llegar'),
                order.phoneKey ? el('a', { className: 'btn btn-secondary btn-small', href: `tel:${order.phoneKey}` }, 'Llamar') : null,
                el('button', { type: 'button', className: 'btn btn-primary btn-small', onClick: event => onDeliver(order, event.currentTarget) }, icon('check'), 'Entregado')));
    }

    function candidateList(isAdding) {
        const list = candidates();
        if (!list.length) return null;
        return el('div', { className: 'delivery-pick' },
            el('h3', { className: 'delivery-subtitle', text: isAdding ? 'Añadir al reparto' : 'Pedidos a domicilio de este domingo' }),
            el('ul', { className: 'delivery-list' }, list.map(order => el('li', {},
                el('label', { className: 'delivery-check' },
                    el('input', {
                        type: 'checkbox',
                        checked: selected.get(order.id) !== false,
                        onChange: event => { selected.set(order.id, event.target.checked); }
                    }),
                    el('span', { className: 'delivery-check-text' },
                        el('strong', { text: `${order.deliverySlot || '—'} · ${order.customerName || 'Sin nombre'}` }),
                        el('span', { className: 'hint', text: order.address })))))),
            el('button', {
                type: 'button',
                className: `btn ${isAdding ? 'btn-secondary' : 'btn-primary'} delivery-start`,
                onClick: event => startRun(event.currentTarget)
            }, icon('car'), isAdding ? 'Añadir al reparto' : 'Salgo a repartir'));
    }

    function render() {
        const stops = active().sort((a, b) => (etas.get(a.id)?.seconds ?? Infinity) - (etas.get(b.id)?.seconds ?? Infinity));
        const children = [];
        if (stops.length) {
            children.push(gpsCard(stops));
            children.push(el('ol', { className: 'delivery-list delivery-stops' }, stops.map(stopCard)));
            children.push(candidateList(true));
            children.push(el('button', { type: 'button', className: 'btn btn-danger delivery-end', onClick: event => endRun(event.currentTarget) }, 'Terminar reparto'));
        } else {
            children.push(candidateList(false) || el('p', { className: 'empty-state', text: 'No hay pedidos a domicilio pendientes de reparto este domingo.' }));
            if (gpsError) children.push(el('p', { className: 'form-message', 'data-type': 'error', text: gpsError }));
        }
        root.replaceChildren(...children.filter(Boolean));
        const status = document.getElementById('deliveryStatus');
        if (status) {
            status.textContent = stops.length ? (watching() ? 'En reparto · ubicación activa' : 'En reparto · ubicación en pausa') : 'Sin reparto';
            status.dataset.state = stops.length ? (watching() ? 'live' : 'paused') : 'idle';
        }
    }

    return {
        // Llamado por admin.js cada vez que cambian los pedidos o el domingo elegido
        update(all, ofSunday) {
            allOrders = all;
            sundayOrders = ofSunday;
            render();
        },
        forget,
        isDelivering: orderId => allOrders.some(o => o.id === orderId && o.status === 'delivering'),
        // Al cerrar sesión: deja de enviar, sin tocar los pedidos
        stop() {
            stopWatching();
            allOrders = [];
            sundayOrders = [];
            render();
        }
    };
}
