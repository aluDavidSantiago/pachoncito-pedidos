// Reparto en directo desde el panel del obrador (solo lógica; el estado de los pedidos llega de admin.js).
//
// «Salgo a repartir»: los pedidos a domicilio elegidos pasan a «En reparto» y por cada uno se crea tracking/{idPedido}
// con su destino. Mientras tanto, este móvil envía su posición (watchPosition) a esos documentos y, cada minuto,
// el tiempo estimado de llegada a cada dirección (OSRM, o en línea recta si falla).
// Al entregar un pedido o al terminar el reparto, su tracking se BORRA: la ubicación solo existe durante el reparto
// y cada cliente solo puede leer la de su pedido (firestore.rules · tracking).
//
// Servicios externos gratuitos, llamados SOLO desde este móvil (nunca desde los clientes):
//   · Nominatim (OpenStreetMap): sitúa cada dirección una sola vez al salir (máx. 1 consulta por segundo).
//   · OSRM (demo pública): tiempo en coche hasta todas las direcciones en una sola consulta por minuto.
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
const OSRM_URL = 'https://router.project-osrm.org/table/v1/driving/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const TOWN = 'Premià de Mar';
// Caja aproximada de Premià de Mar y alrededores: da preferencia a resultados de la zona
const VIEWBOX = '2.30,41.54,2.42,41.46';

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

    // ---------- Direcciones (Nominatim) ----------

    async function geocode(address) {
        const q = new RegExp(TOWN.replace('à', '[àa]'), 'i').test(address) ? address : `${address}, ${TOWN}`;
        const url = `${NOMINATIM_URL}?format=jsonv2&limit=1&countrycodes=es&accept-language=es&viewbox=${VIEWBOX}&q=${encodeURIComponent(q)}`;
        try {
            const response = await fetch(url);
            if (!response.ok) return null;
            const [hit] = await response.json();
            return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
        } catch (error) {
            console.warn('No se pudo situar la dirección:', error);
            return null;
        }
    }

    // ---------- Tiempo estimado (OSRM, o línea recta) ----------

    async function computeEtas(from, stops) {
        const result = new Map();
        const located = stops.filter(o => isPoint(o.destination));
        if (!located.length) return result;
        try {
            const coords = [from, ...located.map(o => o.destination)].map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const response = await fetch(`${OSRM_URL}${coords}?sources=0&annotations=duration,distance`, { signal: controller.signal });
            clearTimeout(timer);
            const data = await response.json();
            if (data.code !== 'Ok') throw new Error(data.code || 'OSRM');
            located.forEach((order, i) => {
                const seconds = data.durations?.[0]?.[i + 1];
                const distance = data.distances?.[0]?.[i + 1];
                if (Number.isFinite(seconds)) result.set(order.id, { seconds: Math.round(seconds), distance: Math.round(distance || 0), method: 'osrm' });
            });
        } catch (error) {
            console.warn('OSRM no disponible; se estima en línea recta:', error);
        }
        // Lo que OSRM no haya resuelto, en línea recta
        for (const order of located) {
            if (!result.has(order.id)) {
                result.set(order.id, {
                    seconds: straightLineEtaSeconds(from, order.destination),
                    distance: Math.round(distanceMeters(from, order.destination)),
                    method: 'linea'
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
                ...(etaUpdate?.has(order.id) ? { eta: etaUpdate.get(order.id), etaAt: serverTimestamp() } : {})
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
