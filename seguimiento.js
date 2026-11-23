// Seguimiento de un pedido (seguimiento.html?pedido=<id>): estado en vivo y, cuando está «En reparto»,
// mapa con la posición del repartidor y tiempo estimado de llegada.
// Todo llega por onSnapshot: orders/{id} (el cliente solo puede leer los suyos) y tracking/{id}, que solo
// existe mientras el repartidor comparte su ubicación y solo lo puede leer el dueño del pedido (firestore.rules).
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { mountEnvBanner } from "./env.js";
import { db } from "./firebase.js";
import { formatDistance, formatMinutes, isPoint, distanceMeters, straightLineEtaSeconds } from "./geo.js";
import { brandStyle, decodePolyline, MAP_STYLE_URL, PALETTES, PREMIA_CENTER } from "./map-style.js";
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

// ---------- Mapa (MapLibre + OpenFreeMap, con los colores de la web) ----------
// Solo dos puntos: el repartidor (en directo) y la dirección de entrega (fija). Nunca la ubicación del cliente.

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
let map = null;
let mapPromise = null;
let mapFailed = false;
let baseStyle = null;
let courierMarker = null;
let destMarker = null;
let fittedOnce = false;
let userMoved = false;
let lastCourier = null;
let animation = null;

function markerElement(name, className, label) {
    const node = el('div', { className: `map-pin ${className}`, role: 'img', 'aria-label': label },
        el('span', { className: 'map-pin-halo', 'aria-hidden': 'true' }),
        el('span', { className: 'map-pin-body' }, icon(name)));
    return node;
}

async function styleForTheme() {
    if (!baseStyle) {
        const response = await fetch(MAP_STYLE_URL);
        if (!response.ok) throw new Error(`Estilo del mapa: ${response.status}`);
        baseStyle = await response.json();
    }
    return brandStyle(structuredClone(baseStyle), darkQuery.matches);
}

// Capas propias: la ruta (dorada) y, si no hay ruta, una línea discontinua aproximada
function addRouteLayers() {
    const colors = darkQuery.matches ? PALETTES.dark : PALETTES.light;
    if (!map.getSource('route')) map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    if (!map.getLayer('route-casing')) {
        map.addLayer({ id: 'route-casing', type: 'line', source: 'route', filter: ['==', ['get', 'kind'], 'route'],
            layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': colors.routeCasing, 'line-width': 9 } });
        map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['==', ['get', 'kind'], 'route'],
            layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': colors.route, 'line-width': 5 } });
        map.addLayer({ id: 'route-guess', type: 'line', source: 'route', filter: ['==', ['get', 'kind'], 'guess'],
            layout: { 'line-cap': 'round' }, paint: { 'line-color': colors.route, 'line-width': 3, 'line-opacity': 0.75, 'line-dasharray': [1, 2.2] } });
    }
}

function setRoute(courier, destination) {
    const source = map?.getSource('route');
    if (!source) return;
    const features = [];
    const encoded = tracking?.route;
    if (encoded && isPoint(destination)) {
        try {
            features.push({ type: 'Feature', properties: { kind: 'route' }, geometry: { type: 'LineString', coordinates: decodePolyline(encoded) } });
        } catch (error) {
            console.warn('Ruta no válida:', error);
        }
    }
    if (!features.length && isPoint(courier) && isPoint(destination)) {
        features.push({ type: 'Feature', properties: { kind: 'guess' }, geometry: { type: 'LineString', coordinates: [[courier.lng, courier.lat], [destination.lng, destination.lat]] } });
    }
    source.setData({ type: 'FeatureCollection', features });
}

function ensureMap() {
    if (map || mapFailed) return Promise.resolve(map);
    if (mapPromise) return mapPromise;
    mapPromise = (async () => {
        try {
            if (!window.maplibregl) throw new Error('MapLibre no se ha cargado');
            const style = await styleForTheme();
            map = new window.maplibregl.Map({
                container: 'trackMap',
                style,
                center: PREMIA_CENTER,
                zoom: 13,
                attributionControl: { compact: true },
                dragRotate: false,
                pitchWithRotate: false,
                touchPitch: false,
                cooperativeGestures: false
            });
            map.touchZoomRotate.disableRotation();
            // Un trozo de mapa que no carga no es motivo para renunciar al mapa: solo si no llega a cargar en 15 s
            map.on('error', event => console.warn('Mapa:', event.error?.message || event));
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('El mapa tarda demasiado en cargar')), 15000);
                map.once('load', () => { clearTimeout(timer); resolve(); });
            });
            addRouteLayers();
            // Si el cliente mueve el mapa, deja de reencuadrarse solo y aparece «volver a centrar»
            map.on('dragstart', () => { userMoved = true; $('mapRecenter').hidden = false; });
            map.on('zoomstart', event => { if (event.originalEvent) { userMoved = true; $('mapRecenter').hidden = false; } });
            darkQuery.addEventListener('change', async () => {
                map.setStyle(await styleForTheme());
                map.once('styledata', () => { addRouteLayers(); renderLive(); });
            });
            return map;
        } catch (error) {
            console.error('No se pudo cargar el mapa:', error);
            mapFailed = true;
            map?.remove();
            map = null;
            $('trackMap').classList.add('is-fallback');
            return null;
        }
    })();
    return mapPromise;
}

function fitBoth(points, animate = true) {
    if (points.length === 2) {
        // Límites bien orientados (suroeste → noreste), sea cual sea la posición relativa de los dos puntos
        const bounds = points.reduce((b, p) => b.extend(p), new window.maplibregl.LngLatBounds(points[0], points[0]));
        map.fitBounds(bounds, { padding: { top: 56, bottom: 132, left: 44, right: 44 }, maxZoom: 16, duration: animate ? 900 : 0 });
    } else if (points.length === 1) {
        map.easeTo({ center: points[0], zoom: 15, duration: animate ? 900 : 0 });
    }
}

// El repartidor se desliza hasta su nueva posición en vez de saltar
function moveCourier(target) {
    if (!courierMarker) return;
    const from = lastCourier || target;
    cancelAnimationFrame(animation);
    const start = performance.now();
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1200;
    const step = now => {
        const t = duration ? Math.min(1, (now - start) / duration) : 1;
        const k = 1 - (1 - t) ** 3;
        courierMarker.setLngLat([from.lng + (target.lng - from.lng) * k, from.lat + (target.lat - from.lat) * k]);
        if (t < 1) animation = requestAnimationFrame(step);
    };
    animation = requestAnimationFrame(step);
    lastCourier = { lat: target.lat, lng: target.lng };
}

async function updateMap(courier, destination) {
    if (!(await ensureMap())) {
        $('mapNote').textContent = 'No se ha podido mostrar el mapa en este dispositivo, pero el tiempo de llegada se sigue actualizando.';
        return;
    }
    map.resize();
    if (isPoint(destination)) {
        if (!destMarker) destMarker = new window.maplibregl.Marker({ element: markerElement('pin', 'map-pin-dest', 'Tu dirección de entrega'), anchor: 'bottom' })
            .setLngLat([destination.lng, destination.lat]).addTo(map);
        else destMarker.setLngLat([destination.lng, destination.lat]);
    }
    if (isPoint(courier)) {
        if (!courierMarker) {
            courierMarker = new window.maplibregl.Marker({ element: markerElement('car', 'map-pin-courier', 'Repartidor'), anchor: 'center' })
                .setLngLat([courier.lng, courier.lat]).addTo(map);
            lastCourier = { lat: courier.lat, lng: courier.lng };
        } else if (!lastCourier || lastCourier.lat !== courier.lat || lastCourier.lng !== courier.lng) {
            moveCourier(courier);
        }
    }
    setRoute(courier, destination);

    const points = [courier, destination].filter(isPoint).map(p => [p.lng, p.lat]);
    if (!points.length || userMoved) return;
    const bounds = map.getBounds();
    const inView = fittedOnce && points.every(p => bounds.contains(p));
    if (!inView) {
        fitBoth(points, fittedOnce);
        fittedOnce = true;
    }
}

$('mapRecenter').addEventListener('click', () => {
    userMoved = false;
    $('mapRecenter').hidden = true;
    const points = [tracking?.courier, tracking?.destination].filter(isPoint).map(p => [p.lng, p.lat]);
    if (map && points.length) fitBoth(points);
});

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

    const eta = isPoint(destination) ? remainingSeconds(courier, destination) : null;
    if (!isPoint(courier)) {
        $('liveTitle').replaceChildren('Saliendo ', el('strong', { id: 'etaMinutes', text: 'del obrador' }));
        $('etaHint').textContent = 'En un momento verás al repartidor en el mapa.';
    } else if (eta) {
        $('liveTitle').replaceChildren('Llega en ', el('strong', { id: 'etaMinutes', text: `~${formatMinutes(eta.seconds)}` }));
        const arrival = new Date(Date.now() + eta.seconds * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        $('etaHint').textContent = `Hacia las ${arrival} · a ${formatDistance(distanceMeters(courier, destination))}`;
    } else {
        // Dirección sin situar en el mapa: sin mensajes de error, solo el repartidor en directo
        $('liveTitle').replaceChildren('Va de camino ', el('strong', { id: 'etaMinutes', text: 'a tu casa' }));
        $('etaHint').textContent = 'Sigue al repartidor en el mapa.';
    }

    $('mapNote').textContent = stale
        ? `Sin señal del repartidor desde hace ${formatMinutes((Date.now() - updated) / 1000)}. Se actualizará en cuanto vuelva la conexión.`
        : 'Se actualiza solo, no hace falta recargar.';
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
