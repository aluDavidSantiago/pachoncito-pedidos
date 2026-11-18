// Cálculos de distancia y tiempo de llegada, compartidos por el panel (admin-delivery.js) y el cliente (seguimiento.js).

// Velocidad media en coche por Premià y alrededores, para la estimación sin rutas (línea recta)
export const FALLBACK_SPEED_KMH = 25;
// La carretera nunca va en línea recta: se alarga la distancia un 30 %
export const ROAD_FACTOR = 1.3;

const toRad = deg => deg * Math.PI / 180;

// Distancia en metros entre dos puntos { lat, lng } (fórmula del haversine)
export function distanceMeters(a, b) {
    const R = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

// Segundos aproximados en coche, sin API de rutas
export function straightLineEtaSeconds(from, to) {
    const meters = distanceMeters(from, to) * ROAD_FACTOR;
    return Math.round(meters / (FALLBACK_SPEED_KMH * 1000 / 3600));
}

export const isPoint = p => Boolean(p) && Number.isFinite(p.lat) && Number.isFinite(p.lng);

// «3 min», «1 h 5 min». Por debajo de un minuto: «menos de 1 min»
export function formatMinutes(seconds) {
    const minutes = Math.round(seconds / 60);
    if (minutes < 1) return 'menos de 1 min';
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatDistance(meters) {
    return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}
