// Dirección de entrega en la carta: sugerencias de direcciones reales de Premià de Mar con el buscador de
// Google Maps (Places API New, si hay clave en shared.js · GOOGLE_MAPS_KEY) o, si no, Photon (OpenStreetMap),
// y un mini mapa con un alfiler que el cliente confirma o arrastra hasta su puerta.
// El punto confirmado se guarda en el pedido (destination): el reparto y el seguimiento lo usan tal cual,
// sin volver a buscar la dirección. Si no se confirma, el panel la busca como antes (admin-delivery.js).
import { isPoint } from "./geo.js";
import { icon } from "./icons.js";
import { brandMapStyle, loadMapLibre, PREMIA_CENTER } from "./map-style.js";
import { el, GOOGLE_MAPS_KEY } from "./shared.js";

export const TOWN = 'Premià de Mar';
export const POSTCODE = '08330';
const PHOTON_URL = 'https://photon.komoot.io/api/';
// Premià de Mar y un margen alrededor: también lo comprueban las reglas (isDeliveryPoint)
export const ZONE = { minLat: 41.47, maxLat: 41.51, minLng: 2.33, maxLng: 2.39 };
export const inZone = p => isPoint(p) && p.lat >= ZONE.minLat && p.lat <= ZONE.maxLat && p.lng >= ZONE.minLng && p.lng <= ZONE.maxLng;

// «Calle Mayor 12» + «2º 1ª» → «Calle Mayor 12, 2º 1ª, 08330 Premià de Mar»
export function composeAddress(street, extra) {
    return [street.trim(), extra.trim(), `${POSTCODE} ${TOWN}`].filter(Boolean).join(', ').slice(0, 200);
}

// Una dirección guardada antes («Calle Mayor 12, 2º 1ª, 08330 Premià de Mar») vuelve a sus dos campos
export function splitAddress(full) {
    const parts = String(full || '').split(',').map(s => s.trim()).filter(Boolean)
        .filter(s => !new RegExp(`^(${POSTCODE}\\s*)?Premi[àa] de Mar$`, 'i').test(s));
    return { street: parts[0] || '', extra: parts.slice(1).join(', ') };
}

// ---------- Sugerencias con Google Maps (Places API New) ----------
// Autocompletar + detalles en una misma «sesión»: Google cobra la sesión, no cada letra (y con poco uso, gratis).
const GOOGLE_AUTOCOMPLETE = 'https://places.googleapis.com/v1/places:autocomplete';
const GOOGLE_PLACE = 'https://places.googleapis.com/v1/places/';
let sessionToken = null;
const newSession = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

async function googleSuggest(query, signal) {
    sessionToken ||= newSession();
    const response = await fetch(GOOGLE_AUTOCOMPLETE, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_MAPS_KEY },
        body: JSON.stringify({
            input: /premi[àa]/i.test(query) ? query : `${query}, ${TOWN}`,
            languageCode: 'es',
            regionCode: 'es',
            includedRegionCodes: ['es'],
            locationRestriction: { rectangle: { low: { latitude: ZONE.minLat, longitude: ZONE.minLng }, high: { latitude: ZONE.maxLat, longitude: ZONE.maxLng } } },
            sessionToken
        })
    });
    if (!response.ok) throw new Error(`Google ${response.status}`);
    const data = await response.json();
    return (data.suggestions || []).map(s => s.placePrediction).filter(Boolean).map(p => ({
        title: p.structuredFormat?.mainText?.text || p.text?.text || '',
        sub: p.structuredFormat?.secondaryText?.text || TOWN,
        placeId: p.placeId,
        hasNumber: /\d/.test(p.structuredFormat?.mainText?.text || '')
    })).filter(s => s.title && s.placeId);
}

// Coordenadas exactas de la sugerencia elegida (cierra la sesión de Google)
async function googlePlace(placeId) {
    const url = `${GOOGLE_PLACE}${encodeURIComponent(placeId)}?languageCode=es${sessionToken ? `&sessionToken=${sessionToken}` : ''}`;
    sessionToken = null;
    const response = await fetch(url, { headers: { 'X-Goog-Api-Key': GOOGLE_MAPS_KEY, 'X-Goog-FieldMask': 'location,shortFormattedAddress' } });
    if (!response.ok) throw new Error(`Google ${response.status}`);
    const data = await response.json();
    return { point: { lat: data.location?.latitude, lng: data.location?.longitude }, label: data.shortFormattedAddress || '' };
}

// Sugerencias: Google si hay clave; si no hay o falla, OpenStreetMap
export async function suggest(query, signal) {
    if (GOOGLE_MAPS_KEY) {
        try {
            return await googleSuggest(query, signal);
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.warn('Google no disponible; se usa OpenStreetMap:', error);
        }
    }
    return photonSuggest(query, signal);
}

// Punto de una sugerencia (las de Google se piden al elegirla)
export async function pointOf(item) {
    if (item.point) return item;
    const place = await googlePlace(item.placeId);
    return { ...item, point: place.point };
}

// ---------- Sugerencias con OpenStreetMap (Photon), de reserva ----------

function label(props) {
    const street = props.street || props.name || '';
    const number = props.housenumber ? ` ${props.housenumber}` : '';
    return { title: `${street}${number}`.trim(), sub: [props.postcode, props.city || props.district].filter(Boolean).join(' ') };
}

async function photonSuggest(query, signal) {
    const url = `${PHOTON_URL}?limit=6&lang=es&lat=${PREMIA_CENTER[1]}&lon=${PREMIA_CENTER[0]}`
        + `&bbox=${ZONE.minLng},${ZONE.minLat},${ZONE.maxLng},${ZONE.maxLat}&layer=house&layer=street`
        + `&q=${encodeURIComponent(`${query} ${TOWN}`)}`;
    const response = await fetch(url, { signal });
    if (!response.ok) return [];
    const data = await response.json();
    const seen = new Set();
    return (data.features || []).map(f => {
        const [lng, lat] = f.geometry?.coordinates || [];
        const { title, sub } = label(f.properties || {});
        return { title, sub, point: { lat, lng }, hasNumber: Boolean(f.properties?.housenumber) };
    }).filter(s => s.title && inZone(s.point) && !seen.has(s.title) && seen.add(s.title));
}

// ---------- Mini mapa con alfiler ----------

// Controla el bloque de dirección de la carta. onChange(point|null) cada vez que cambia el punto confirmado.
export function mountAddressPicker({ input, list, mapBox, hint, onChange }) {
    let point = null;
    let map = null;
    let marker = null;
    let controller = null;
    let timer = null;
    let active = -1;
    let items = [];

    function setPoint(next, { fly = true } = {}) {
        point = inZone(next) ? { lat: Number(next.lat.toFixed(6)), lng: Number(next.lng.toFixed(6)) } : null;
        onChange?.(point);
        if (!point) {
            mapBox.hidden = true;
            hint.textContent = '';
            return;
        }
        mapBox.hidden = false;
        hint.textContent = 'Comprueba que el alfiler está en tu puerta. Si no, arrástralo hasta ella.';
        showMap(fly);
    }

    async function showMap(fly) {
        try {
            const gl = await loadMapLibre();
            if (!map) {
                const style = await brandMapStyle();
                map = new gl.Map({ container: mapBox.querySelector('.address-map'), style, center: [point.lng, point.lat], zoom: 17,
                    attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false });
                map.touchZoomRotate.disableRotation();
                const pin = el('div', { className: 'map-pin map-pin-dest', role: 'img', 'aria-label': 'Tu puerta' },
                    el('span', { className: 'map-pin-body' }, icon('pin')));
                marker = new gl.Marker({ element: pin, anchor: 'bottom', draggable: true }).setLngLat([point.lng, point.lat]).addTo(map);
                marker.on('dragend', () => {
                    const { lng, lat } = marker.getLngLat();
                    if (inZone({ lat, lng })) {
                        point = { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
                        onChange?.(point);
                        hint.textContent = 'Perfecto, lo llevaremos justo ahí.';
                    } else {
                        marker.setLngLat([point.lng, point.lat]);
                        hint.textContent = 'Solo repartimos en Premià de Mar: deja el alfiler dentro del pueblo.';
                    }
                });
                // Tocar el mapa también mueve el alfiler (más cómodo en el móvil)
                map.on('click', event => {
                    marker.setLngLat(event.lngLat);
                    marker.fire('dragend');
                });
            } else {
                map.resize();
                marker.setLngLat([point.lng, point.lat]);
                if (fly) map.easeTo({ center: [point.lng, point.lat], zoom: 17, duration: 500 });
            }
        } catch (error) {
            console.warn('Mapa de dirección no disponible:', error);
            mapBox.hidden = true;
            hint.textContent = 'Dirección encontrada.';
        }
    }

    function close() {
        list.hidden = true;
        list.replaceChildren();
        input.setAttribute('aria-expanded', 'false');
        active = -1;
    }

    async function choose(item) {
        input.value = item.hasNumber ? item.title : mergeNumber(item.title, input.value);
        close();
        try {
            const located = await pointOf(item);
            setPoint(located.point);
            if (!point) hint.textContent = 'Esa dirección queda fuera de Premià de Mar. Revisa la calle, por favor.';
        } catch (error) {
            console.warn('No se pudo situar la dirección:', error);
            hint.textContent = 'No hemos podido situar la dirección. Puedes reservar igualmente.';
        }
    }

    // Si la sugerencia es solo la calle, se conserva el número que escribió el cliente
    function mergeNumber(street, typed) {
        const number = typed.match(/\b(\d+[a-z]?)\b/i)?.[1];
        return number ? `${street} ${number}` : street;
    }

    function render() {
        list.replaceChildren(...items.map((item, i) => el('li', {
            role: 'option',
            id: `addr-opt-${i}`,
            className: `address-option${i === active ? ' is-active' : ''}`,
            'aria-selected': String(i === active),
            onMousedown: event => { event.preventDefault(); choose(item); }
        }, el('strong', { text: item.title }), el('span', { text: item.sub || TOWN }))));
        list.hidden = !items.length;
        input.setAttribute('aria-expanded', String(Boolean(items.length)));
        if (active >= 0) input.setAttribute('aria-activedescendant', `addr-opt-${active}`);
        else input.removeAttribute('aria-activedescendant');
    }

    input.addEventListener('input', () => {
        setPoint(null);
        clearTimeout(timer);
        const query = input.value.trim();
        if (query.length < 3) { close(); return; }
        timer = setTimeout(async () => {
            controller?.abort();
            controller = new AbortController();
            try {
                items = await suggest(query, controller.signal);
                active = -1;
                render();
            } catch (error) {
                if (error.name !== 'AbortError') console.warn('Sugerencias no disponibles:', error);
            }
        }, 300);
    });

    input.addEventListener('keydown', event => {
        if (list.hidden) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            active = (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            render();
        } else if (event.key === 'Enter' && active >= 0) {
            event.preventDefault();
            choose(items[active]);
        } else if (event.key === 'Escape') {
            close();
        }
    });
    input.addEventListener('blur', () => setTimeout(close, 150));

    return {
        get point() { return point; },
        // Al reservar sin haber elegido sugerencia: se intenta situar la dirección escrita una vez
        async resolve() {
            if (point || input.value.trim().length < 5) return point;
            try {
                const [best] = await suggest(input.value.trim());
                if (best) setPoint((await pointOf(best)).point, { fly: false });
            } catch { /* sin conexión con el buscador: el panel la buscará después */ }
            return point;
        },
        set(next) { setPoint(next, { fly: false }); },
        refresh() { if (point) showMap(false); }
    };
}
