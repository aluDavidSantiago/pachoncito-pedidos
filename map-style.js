// Estilo del mapa de seguimiento con los colores de Pachoncito.
// Base: OpenFreeMap «Positron» (vectorial, gratis, sin clave y con uso comercial permitido; datos de OpenStreetMap).
// Se recolorea por capas del esquema OpenMapTiles (water, landcover, transportation, building…), que es estable
// aunque OpenFreeMap cambie los nombres de las capas de su estilo.
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

// Centro de Premià de Mar (vista inicial antes de tener posiciones)
export const PREMIA_CENTER = [2.3606, 41.4917];

// Mismas familias de color que style.css (crema / caramelo de día, negro cálido / ámbar de noche)
export const PALETTES = {
    light: {
        land: '#f5efe6', landuse: '#efe7da', green: '#e9e5d2', water: '#d8e0dc', building: '#e9ddc9',
        road: '#fffcf7', roadMajor: '#f6deb2', casing: '#e2d5c0', rail: '#d8cbb6',
        label: '#7a6858', waterLabel: '#8a9e9c', halo: '#f5efe6',
        route: '#c98a2e', routeCasing: '#fffcf7'
    },
    dark: {
        land: '#16120f', landuse: '#1b1612', green: '#1b1a14', water: '#121a1c', building: '#241d18',
        road: '#2c241e', roadMajor: '#3d3024', casing: '#0d0a08', rail: '#2a231e',
        label: '#a99c8b', waterLabel: '#58706f', halo: '#16120f',
        route: '#e6a54d', routeCasing: '#110e0c'
    }
};

const HIDDEN_SOURCE_LAYERS = ['poi', 'housenumber', 'aerodrome_label', 'mountain_peak', 'boundary', 'aeroway'];

function hide(layer) {
    layer.layout = { ...(layer.layout || {}), visibility: 'none' };
}

// Devuelve el estilo recoloreado (modifica y devuelve el mismo objeto; pásale una copia)
export function brandStyle(style, dark = false) {
    const p = dark ? PALETTES.dark : PALETTES.light;
    for (const layer of style.layers || []) {
        const source = layer['source-layer'] || '';
        const id = String(layer.id || '').toLowerCase();
        layer.paint = layer.paint || {};

        if (HIDDEN_SOURCE_LAYERS.includes(source)) { hide(layer); continue; }

        switch (layer.type) {
            case 'background':
                layer.paint['background-color'] = p.land;
                delete layer.paint['background-pattern'];
                break;
            case 'fill': {
                const color = source === 'water' ? p.water
                    : source === 'building' ? p.building
                        : source === 'park' || source === 'landcover' ? p.green
                            : p.landuse;
                layer.paint['fill-color'] = color;
                layer.paint['fill-outline-color'] = color;
                delete layer.paint['fill-pattern'];
                if (source === 'building') layer.paint['fill-opacity'] = 0.9;
                break;
            }
            case 'fill-extrusion':
                layer.paint['fill-extrusion-color'] = p.building;
                break;
            case 'line':
                delete layer.paint['line-pattern'];
                if (source === 'water' || source === 'waterway') layer.paint['line-color'] = p.water;
                else if (source === 'transportation') {
                    layer.paint['line-color'] = /rail|transit|ferry|cable|subway|tram/.test(id) ? p.rail
                        : /casing|outline/.test(id) ? p.casing
                            : /motorway|trunk|primary|major/.test(id) ? p.roadMajor
                                : p.road;
                } else layer.paint['line-color'] = p.casing;
                break;
            case 'symbol':
                if (layer.layout?.['icon-image'] && !layer.layout?.['text-field']) { hide(layer); break; }
                if (layer.layout) delete layer.layout['icon-image'];
                layer.paint['text-color'] = source === 'water' || source === 'water_name' || source === 'waterway' ? p.waterLabel : p.label;
                layer.paint['text-halo-color'] = p.halo;
                layer.paint['text-halo-width'] = 1.2;
                break;
            default:
                break;
        }
    }
    return style;
}

// MapLibre se carga solo cuando hace falta (carta a domicilio, panel de reparto). Versión fija con firma.
const MAPLIBRE_JS = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js';
const MAPLIBRE_CSS = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css';
let maplibrePromise = null;
export function loadMapLibre() {
    if (window.maplibregl) return Promise.resolve(window.maplibregl);
    if (maplibrePromise) return maplibrePromise;
    maplibrePromise = new Promise((resolve, reject) => {
        const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: MAPLIBRE_CSS, crossOrigin: 'anonymous',
            integrity: 'sha384-MinO0mNliZ3vwppuPOUnGa+iq619pfMhLVUXfC4LHwSCvF9H+6P/KO4Q7qBOYV5V' });
        const js = Object.assign(document.createElement('script'), { src: MAPLIBRE_JS, crossOrigin: 'anonymous',
            integrity: 'sha384-SYKAG6cglRMN0RVvhNeBY0r3FYKNOJtznwA0v7B5Vp9tr31xAHsZC0DqkQ/pZDmj' });
        js.onload = () => resolve(window.maplibregl);
        js.onerror = () => { maplibrePromise = null; reject(new Error('No se pudo cargar el mapa')); };
        document.head.append(css, js);
    });
    return maplibrePromise;
}

// Estilo de la marca listo para usar (si OpenFreeMap no responde, un fondo liso)
export async function brandMapStyle(dark = matchMedia('(prefers-color-scheme: dark)').matches) {
    try {
        const response = await fetch(MAP_STYLE_URL);
        if (!response.ok) throw new Error(String(response.status));
        return brandStyle(await response.json(), dark);
    } catch {
        return { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': dark ? '#16120f' : '#efe7da' } }] };
    }
}

// Decodifica una polilínea de OSRM (precisión 5) a [[lng, lat], …]
export function decodePolyline(encoded, precision = 5) {
    const factor = 10 ** precision;
    const coords = [];
    let index = 0, lat = 0, lng = 0;
    while (index < encoded.length) {
        for (const axis of [0, 1]) {
            let shift = 0, result = 0, byte;
            do {
                byte = encoded.charCodeAt(index++) - 63;
                result |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            const delta = result & 1 ? ~(result >> 1) : result >> 1;
            if (axis === 0) lat += delta; else lng += delta;
        }
        coords.push([lng / factor, lat / factor]);
    }
    return coords;
}
