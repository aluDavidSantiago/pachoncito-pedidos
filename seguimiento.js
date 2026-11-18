// Seguimiento de un pedido (seguimiento.html?pedido=<id>): estado en vivo y, cuando está «En reparto»,
// mapa con la posición del repartidor y tiempo estimado de llegada.
// Todo llega por onSnapshot: orders/{id} (el cliente solo puede leer los suyos) y tracking/{id}, que solo
// existe mientras el repartidor comparte su ubicación y solo lo puede leer el dueño del pedido (firestore.rules).
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { mountEnvBanner } from "./env.js";
import { db } from "./firebase.js";
import { formatDistance, formatMinutes, isPoint, distanceMeters, straightLineEtaSeconds } from "./geo.js";
import { hydrateIcons, icon } from "./icons.js";
import { customerStatus, normalizeOrder, trackingSteps, WELCOME_GIFT_LABEL, WELCOME_GIFT_PRODUCT } from "./orders.js";
import { registerServiceWorker } from "./pwa.js";
import { requireCustomer } from "./session.js";
import { el, formatDate, formatEUR, PRODUCT_NAMES, showMessage } from "./shared.js";
import { initUI, mountTopNav, toast } from "./ui.js";

mountEnvBanner();
registerServiceWorker();
hydrateIcons();
initUI();

const { profile } = await requireCustomer();
mountTopNav(profile);
const $ = id => document.getElementById(id);

const orderId = new URLSearchParams(location.search).get('pedido');
const STALE_MS = 90 * 1000; // sin noticias del repartidor durante más de 90 s: se avisa

let order = null;
let tracking = null;
let stopTracking = null;
let lastStatus = null;

function fail(text) {
    $('trackLoading').hidden = true;
    $('trackView').hidden = true;
    showMessage($('trackMessage'), text, 'error');
}

// ---------- Estado y pasos ----------

function leadText() {
    const slot = order.deliverySlot ? ` a las ${order.deliverySlot}` : '';
    switch (order.status) {
        case 'pending': return `Lo tenemos apuntado para el domingo${slot}.`;
        case 'preparing': return 'Tu tanda está en el horno.';
        case 'ready': return order.deliveryMethod === 'domicilio'
            ? 'Recién horneado: sale enseguida hacia tu casa.'
            : `Ya puedes recogerlo en el obrador${slot}.`;
        case 'delivering': return 'Va de camino. Sigue el reparto en el mapa.';
        case 'completed': return 'Entregado. ¡Que lo disfrutes!';
        case 'rejected': return 'Este pedido se ha cancelado. Si no sabes por qué, escríbenos.';
        default: return '';
    }
}

function renderOrder() {
    const status = customerStatus(order);
    $('trackBadge').className = `badge-status ${status.className}`;
    $('trackBadge').textContent = status.text;
    $('trackTitle').textContent = order.createdAt ? `Pedido del ${formatDate(order.createdAt)}` : 'Tu pedido';
    $('trackLead').textContent = leadText();

    $('trackSteps').hidden = order.status === 'rejected';
    $('trackSteps').replaceChildren(...trackingSteps(order).map(step => el('li', {
        className: `track-step is-${step.state}`,
        'aria-current': step.state === 'current' ? 'step' : null
    }, el('span', { className: 'track-dot' }, step.state === 'done' ? icon('check') : null), el('span', { text: step.label }))));

    const lines = Object.entries(PRODUCT_NAMES)
        .filter(([key]) => order.items?.[key] > 0)
        .map(([key, name]) => `${order.items[key]} × ${name}`);
    if (order.welcomeGift) lines.push(`1 × ${PRODUCT_NAMES[WELCOME_GIFT_PRODUCT]} · ${WELCOME_GIFT_LABEL} (gratis)`);
    if (order.napaCount > 0) lines.push(`${order.napaCount} ${order.napaCount === 1 ? 'ñapa' : 'ñapas'} de regalo`);
    lines.push(order.deliveryMethod === 'domicilio' ? `A domicilio · ${order.address}` : 'Recogida en el obrador');
    lines.push(`Domingo a las ${order.deliverySlot || '—'}`);
    lines.push(`Total ${formatEUR(order.totalCents)} · efectivo o Bizum al recibirlo`);
    $('trackSummary').replaceChildren(...lines.map(text => el('li', { text })));

    if (lastStatus && lastStatus !== order.status) toast(`Tu pedido: ${status.text.toLowerCase()}.`, 'success');
    lastStatus = order.status;

    // El reparto en directo solo se escucha mientras el pedido está «En reparto»
    if (order.status === 'delivering' && !stopTracking) {
        stopTracking = onSnapshot(doc(db, 'tracking', orderId), snap => {
            tracking = snap.exists() ? snap.data() : null;
            renderLive();
        }, error => {
            console.error('Error al leer el seguimiento:', error);
            tracking = null;
            renderLive();
        });
    } else if (order.status !== 'delivering' && stopTracking) {
        stopTracking();
        stopTracking = null;
        tracking = null;
    }
    renderLive();
}

// ---------- Mapa (Leaflet + OpenStreetMap) ----------

let map = null;
let courierMarker = null;
let destMarker = null;
let fittedOnce = false;

function markerIcon(name, className) {
    const holder = el('span', { className }, icon(name));
    return window.L.divIcon({ className: 'map-marker', html: holder.outerHTML, iconSize: [40, 40], iconAnchor: [20, 20] });
}

function ensureMap() {
    if (map || !window.L) return map;
    map = window.L.map('trackMap', { zoomControl: false, attributionControl: true });
    window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
    }).addTo(map);
    window.L.control.zoom({ position: 'bottomright' }).addTo(map);
    return map;
}

function updateMap(courier, destination) {
    if (!ensureMap()) {
        $('mapNote').textContent = 'No se ha podido cargar el mapa. Revisa tu conexión.';
        return;
    }
    map.invalidateSize();
    if (isPoint(destination)) {
        if (!destMarker) destMarker = window.L.marker([destination.lat, destination.lng], { icon: markerIcon('pin', 'map-dest'), title: 'Tu dirección', keyboard: false }).addTo(map);
        else destMarker.setLatLng([destination.lat, destination.lng]);
    }
    if (isPoint(courier)) {
        if (!courierMarker) courierMarker = window.L.marker([courier.lat, courier.lng], { icon: markerIcon('car', 'map-courier'), title: 'Repartidor', keyboard: false, zIndexOffset: 1000 }).addTo(map);
        else courierMarker.setLatLng([courier.lat, courier.lng]);
    }
    const points = [courier, destination].filter(isPoint).map(p => [p.lat, p.lng]);
    if (!points.length) return;
    // Primera vez, o si el repartidor o la dirección quedan fuera de la vista: se reencuadran los dos
    const inView = fittedOnce && points.every(p => map.getBounds().pad(-0.1).contains(p));
    if (!inView) {
        fittedOnce = true;
        if (points.length === 2) map.fitBounds(points, { padding: [48, 48], maxZoom: 16 });
        else map.setView(points[0], 15);
    }
}

// ---------- Reparto en directo ----------

// Segundos que faltan: la estimación del repartidor descontando el tiempo desde que se calculó;
// si no hay, en línea recta desde su última posición
function remainingSeconds(courier, destination) {
    const eta = tracking?.eta;
    const at = tracking?.etaAt?.toMillis?.();
    if (eta && Number.isFinite(eta.seconds) && at) {
        return { seconds: Math.max(60, eta.seconds - (Date.now() - at) / 1000), method: eta.method };
    }
    if (isPoint(courier) && isPoint(destination)) return { seconds: straightLineEtaSeconds(courier, destination), method: 'linea' };
    return null;
}

function renderLive() {
    const live = order?.status === 'delivering' && tracking;
    $('trackLive').hidden = !live;
    if (!live) return;

    const courier = tracking.courier;
    const destination = tracking.destination;
    const updated = tracking.updatedAt?.toMillis?.();
    const stale = updated && Date.now() - updated > STALE_MS;

    const eta = remainingSeconds(courier, destination);
    if (!isPoint(courier)) {
        $('etaMinutes').textContent = 'un momento';
        $('etaHint').textContent = 'El repartidor está saliendo del obrador.';
    } else if (eta) {
        $('etaMinutes').textContent = `~${formatMinutes(eta.seconds)}`;
        const arrival = new Date(Date.now() + eta.seconds * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        const far = isPoint(destination) ? ` · a ${formatDistance(distanceMeters(courier, destination))}` : '';
        $('etaHint').textContent = `Hacia las ${arrival}${far} · ${eta.method === 'osrm' ? 'según la ruta en coche' : 'estimación aproximada'}`;
    } else {
        $('etaMinutes').textContent = 'poco';
        $('etaHint').textContent = 'No hemos podido situar tu dirección en el mapa, pero va de camino.';
    }

    $('mapNote').textContent = stale
        ? `Sin señal del repartidor desde hace ${formatMinutes((Date.now() - updated) / 1000)}. Su posición se actualizará en cuanto vuelva la conexión.`
        : (isPoint(destination) ? 'Se actualiza solo, no hace falta recargar.' : 'Tu dirección no aparece en el mapa: el repartidor la tiene apuntada.');
    $('trackLive').classList.toggle('is-stale', Boolean(stale));

    if (isPoint(courier) || isPoint(destination)) updateMap(courier, destination);
}

// Las cifras de tiempo se refrescan aunque no llegue una posición nueva
setInterval(() => { if (order?.status === 'delivering' && tracking) renderLive(); }, 20000);

// ---------- Inicio ----------

if (!orderId) {
    fail('No sabemos qué pedido quieres seguir. Ábrelo desde «Mi cuenta».');
} else {
    onSnapshot(doc(db, 'orders', orderId), snap => {
        if (!snap.exists()) {
            fail('No encontramos este pedido. Ábrelo desde «Mi cuenta».');
            return;
        }
        order = normalizeOrder(snap);
        $('trackLoading').hidden = true;
        $('trackView').hidden = false;
        showMessage($('trackMessage'), '');
        renderOrder();
    }, error => {
        console.error('Error al leer el pedido:', error);
        fail('No encontramos este pedido en tu cuenta. Ábrelo desde «Mi cuenta».');
    });
}
