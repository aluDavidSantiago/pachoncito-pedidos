// Navegación dentro del panel mientras se reparte. En el iPhone, al pasar a Google Maps, Safari deja de enviar la
// ubicación (lo impone iOS), así que la ruta se ve aquí mismo: mapa que sigue al repartidor, ruta dorada hasta la
// siguiente entrega y la próxima indicación («En 150 m, gira a la derecha por Carrer…»), con datos de OSRM.
import { distanceMeters, formatDistance, isPoint } from "./geo.js";
import { icon } from "./icons.js";
import { brandMapStyle, decodePolyline, loadMapLibre, PALETTES } from "./map-style.js";
import { el } from "./shared.js";

const TURN = {
    left: 'gira a la izquierda', right: 'gira a la derecha',
    'slight left': 'gira ligeramente a la izquierda', 'slight right': 'gira ligeramente a la derecha',
    'sharp left': 'gira cerrado a la izquierda', 'sharp right': 'gira cerrado a la derecha',
    straight: 'sigue recto', uturn: 'da la vuelta'
};
const ORDINAL = ['', 'primera', 'segunda', 'tercera', 'cuarta', 'quinta', 'sexta'];

// Paso de OSRM → indicación en castellano
export function instruction(step) {
    const m = step.maneuver || {};
    const name = step.name ? ` por ${step.name}` : '';
    const turn = TURN[m.modifier] || 'sigue';
    switch (m.type) {
        case 'depart': return `Sal${name || ' hacia tu destino'}`;
        case 'arrive': return 'Has llegado al destino';
        case 'roundabout':
        case 'rotary':
        case 'roundabout turn':
            return `En la rotonda, toma la ${ORDINAL[m.exit] || `${m.exit || ''}ª`} salida${name}`;
        case 'continue':
        case 'new name':
            return m.modifier && m.modifier !== 'straight' ? `${cap(turn)}${name}` : `Sigue${name || ' recto'}`;
        case 'end of road':
        case 'fork':
        case 'merge':
        case 'on ramp':
        case 'off ramp':
        case 'turn':
        default:
            return `${cap(turn)}${name}`;
    }
}
const cap = text => text.charAt(0).toUpperCase() + text.slice(1);

// Pasos de una ruta OSRM listos para guiar: texto y punto de la maniobra
export function stepsFromRoute(route) {
    return (route.legs?.[0]?.steps || []).map(step => ({
        text: instruction(step),
        point: { lng: step.maneuver.location[0], lat: step.maneuver.location[1] },
        type: step.maneuver.type
    }));
}

export function createNav(root) {
    let map = null;
    let mapPromise = null;
    let courierMarker = null;
    let stopMarkers = new Map();
    let follow = true;
    let target = null; // { id, steps, index }

    root.innerHTML = '';
    const mapEl = el('div', { className: 'nav-map', role: 'application', 'aria-label': 'Mapa de reparto' });
    const now = el('strong', { className: 'nav-now', text: 'Calculando la ruta…' });
    const next = el('span', { className: 'nav-next' });
    const recenter = el('button', { type: 'button', className: 'map-recenter', 'aria-label': 'Seguir mi posición', hidden: true,
        onClick: () => { follow = true; recenter.hidden = true; } }, icon('car'));
    root.append(el('div', { className: 'nav-card' },
        el('div', { className: 'nav-instruction', 'aria-live': 'polite' }, el('span', { className: 'nav-icon' }, icon('route')), el('div', {}, now, next)),
        el('div', { className: 'nav-map-wrap' }, mapEl, recenter)));

    async function ensureMap(center) {
        if (map || mapPromise) return mapPromise;
        mapPromise = (async () => {
            const gl = await loadMapLibre();
            map = new gl.Map({ container: mapEl, style: await brandMapStyle(), center: [center.lng, center.lat], zoom: 16,
                attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false });
            map.touchZoomRotate.disableRotation();
            await new Promise(resolve => map.once('load', resolve));
            const color = PALETTES[matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'];
            map.addSource('nav-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({ id: 'nav-route-casing', type: 'line', source: 'nav-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': color.routeCasing, 'line-width': 10 } });
            map.addLayer({ id: 'nav-route', type: 'line', source: 'nav-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': color.route, 'line-width': 6 } });
            map.on('dragstart', () => { follow = false; recenter.hidden = false; });
            courierMarker = new gl.Marker({ element: el('div', { className: 'map-pin map-pin-courier' }, el('span', { className: 'map-pin-halo' }), el('span', { className: 'map-pin-body' }, icon('car'))), anchor: 'center' })
                .setLngLat([center.lng, center.lat]).addTo(map);
            return map;
        })().catch(error => {
            console.warn('Mapa de reparto no disponible:', error);
            mapEl.hidden = true;
            mapPromise = null;
            return null;
        });
        return mapPromise;
    }

    return {
        // courier: posición; stops: pedidos en reparto ordenados (el primero es el siguiente); etas: Map id → { route, steps }
        async update(courier, stops, etas) {
            root.hidden = !stops.length;
            if (!stops.length) return;
            const first = stops[0];
            const info = etas.get(first.id);
            if (!isPoint(courier)) { now.textContent = 'Buscando tu posición GPS…'; next.textContent = ''; return; }
            const m = await ensureMap(courier);

            // Indicación: avanza al paso siguiente al pasar a menos de 25 m de cada maniobra
            if (!target || target.id !== first.id || target.steps !== info?.steps) target = { id: first.id, steps: info?.steps || [], index: 1 };
            while (target.index < target.steps.length - 1 && distanceMeters(courier, target.steps[target.index].point) < 25) target.index++;
            const step = target.steps[target.index];
            const after = target.steps[target.index + 1];
            const toDest = isPoint(first.destination) ? distanceMeters(courier, first.destination) : null;
            if (toDest !== null && toDest < 40) {
                now.textContent = `Has llegado: ${first.customerName || 'cliente'}`;
                next.textContent = first.address || '';
            } else if (step) {
                now.textContent = `En ${formatDistance(distanceMeters(courier, step.point))}, ${step.text.charAt(0).toLowerCase()}${step.text.slice(1)}`;
                next.textContent = after ? `Después: ${after.text.charAt(0).toLowerCase()}${after.text.slice(1)}` : `Hacia ${first.customerName || 'el cliente'} · ${first.address || ''}`;
            } else {
                now.textContent = `Hacia ${first.customerName || 'el cliente'}${toDest !== null ? ` · a ${formatDistance(toDest)}` : ''}`;
                next.textContent = first.address || '';
            }
            if (!m) return;

            courierMarker.setLngLat([courier.lng, courier.lat]);
            const gl = window.maplibregl;
            // Paradas numeradas
            const ids = new Set(stops.map(s => s.id));
            for (const [id, marker] of stopMarkers) if (!ids.has(id)) { marker.remove(); stopMarkers.delete(id); }
            stops.forEach((stop, i) => {
                if (!isPoint(stop.destination)) return;
                let marker = stopMarkers.get(stop.id);
                if (!marker) {
                    marker = new gl.Marker({ element: el('div', { className: 'nav-stop', text: String(i + 1) }), anchor: 'center' })
                        .setLngLat([stop.destination.lng, stop.destination.lat]).addTo(m);
                    stopMarkers.set(stop.id, marker);
                }
                marker.getElement().textContent = String(i + 1);
                marker.getElement().classList.toggle('is-next', i === 0);
                marker.setLngLat([stop.destination.lng, stop.destination.lat]);
            });
            // Ruta hasta la siguiente entrega (o línea recta si no hay ruta)
            const line = info?.route ? decodePolyline(info.route) : isPoint(first.destination) ? [[courier.lng, courier.lat], [first.destination.lng, first.destination.lat]] : [];
            m.getSource('nav-route')?.setData({ type: 'FeatureCollection', features: line.length ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } }] : [] });
            if (follow) m.easeTo({ center: [courier.lng, courier.lat], zoom: Math.max(m.getZoom(), 16), duration: 800 });
        },
        stop() {
            root.hidden = true;
            target = null;
        }
    };
}
