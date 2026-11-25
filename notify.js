// Aviso al obrador de cada pedido nuevo en su iPhone/iPad, sin servidor propio: ntfy (https://ntfy.sh, gratis).
// El obrador instala la app «ntfy» y se suscribe al canal NOTIFY_TOPIC. El aviso NO lleva datos personales
// (ni nombre, ni teléfono, ni dirección): solo cuántos pandebonos, la hora y si es a domicilio.
// Si el canal se filtrase, como mucho alguien podría mandar avisos falsos: no puede leer pedidos.
export const NOTIFY_TOPIC = 'pachoncito-obrador-530e45db990a';
const NTFY_URL = `https://ntfy.sh/${NOTIFY_TOPIC}`;

export function notifyNewOrder(order, { test = false } = {}) {
    const units = (order.items?.clasico || 0) + (order.items?.bocadillo || 0);
    const where = order.deliveryMethod === 'domicilio' ? 'a domicilio' : 'recogida';
    const extras = [order.welcomeGift && 'con regalo de bienvenida', order.napaCount > 0 && `${order.napaCount} ñapa(s)`].filter(Boolean);
    const body = `${units} ${units === 1 ? 'pandebono' : 'pandebonos'} · domingo ${order.deliverySlot} · ${where}`
        + (extras.length ? ` · ${extras.join(', ')}` : '');
    // Envío «sin esperar»: si falla (sin conexión, ntfy caído), el pedido ya está guardado igualmente
    return fetch(NTFY_URL, {
        method: 'POST',
        body,
        headers: {
            Title: test ? 'Pedido de PRUEBA' : 'Nuevo pedido en Pachoncito',
            Tags: test ? 'test_tube' : 'bread',
            Priority: test ? '2' : '4',
            Click: 'https://pachoncito.es/admin.html'
        },
        keepalive: true
    }).catch(error => console.warn('No se pudo avisar al obrador:', error));
}
