import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { db } from "./firebase.js";
import { DELIVERY_CENTS, el, formatEUR, MAX_QTY, NAPA_EVERY_CENTS, normalizePhone, PRICES_CENTS, showMessage, storage } from "./shared.js";

const $ = id => document.getElementById(id);
const form = $('orderForm');
const submitBtn = $('submitBtn');
const message = $('formMessage');
const SUBMIT_LABEL = submitBtn.textContent;
const quantities = { clasico: 0, bocadillo: 0 };

// Precios visibles desde la misma fuente que usa el cálculo
document.querySelectorAll('[data-price]').forEach(node => {
    node.textContent = formatEUR(PRICES_CENTS[node.dataset.price]);
});

// Franjas de 30 minutos entre 06:00 y 17:30
for (let minutes = 6 * 60; minutes <= 17 * 60 + 30; minutes += 30) {
    const slot = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${minutes % 60 === 0 ? '00' : '30'}`;
    $('hora').append(new Option(slot, slot));
}

function computeOrder() {
    const deliveryMethod = $('tipoEntrega').value;
    const subtotalCents = quantities.clasico * PRICES_CENTS.clasico + quantities.bocadillo * PRICES_CENTS.bocadillo;
    const deliveryCents = deliveryMethod === 'domicilio' ? DELIVERY_CENTS : 0;
    const totalCents = subtotalCents + deliveryCents;
    // Las ñapas se calculan cada 10 € del total (incluyendo el envío)
    return { deliveryMethod, subtotalCents, deliveryCents, totalCents, napaCount: Math.floor(totalCents / NAPA_EVERY_CENTS) };
}

function updateSummary() {
    const { totalCents, napaCount } = computeOrder();
    $('totalPrice').textContent = formatEUR(totalCents);

    const alertBox = $('napaAlert');
    alertBox.classList.toggle('is-success', napaCount > 0);
    if (napaCount > 0) {
        alertBox.replaceChildren(
            '🎉 ¡Felicidades! Te has ganado ',
            el('strong', { text: `${napaCount} ${napaCount === 1 ? 'Ñapa gratis' : 'Ñapas gratis'}` }),
            ' 🥖✨'
        );
    } else {
        alertBox.textContent = `🎁 ¡Añade ${formatEUR(NAPA_EVERY_CENTS - totalCents)} más para llevarte tu primera Ñapa gratis!`;
    }
}

function setQty(product, value) {
    quantities[product] = Math.min(MAX_QTY, Math.max(0, value));
    $(product).textContent = quantities[product];
}

form.addEventListener('click', event => {
    const button = event.target.closest('[data-product]');
    if (!button) return;
    const product = button.dataset.product;
    setQty(product, quantities[product] + Number(button.dataset.delta));
    updateSummary();
});

function toggleDireccion() {
    const isHome = $('tipoEntrega').value === 'domicilio';
    $('direccionBox').hidden = !isHome;
    $('direccion').required = isHome;
    updateSummary();
}

$('tipoEntrega').addEventListener('change', toggleDireccion);

// Datos guardados de pedidos anteriores o de "Mi cuenta"
function prefill() {
    const savedUser = storage.get('pachoncito_user');
    if (savedUser) {
        $('nombre').value = savedUser.name || '';
        $('telefono').value = savedUser.phone || '';
        $('direccion').value = savedUser.address || '';
    }
    // Enlaces compartidos tipo index.html?ref=600123456
    const referral = new URLSearchParams(location.search).get('ref') || storage.get('pachoncito_ref');
    if (referral) $('referido').value = referral;
}

function fail(text, field) {
    showMessage(message, text, 'error');
    if (field) field.focus();
    else message.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

form.addEventListener('submit', async event => {
    event.preventDefault();
    showMessage(message, '');

    const nombre = $('nombre').value.trim();
    const phone = normalizePhone($('telefono').value);
    const direccion = $('direccion').value.trim();
    const hora = $('hora').value;
    const referralRaw = $('referido').value.trim();
    const referralCode = referralRaw ? normalizePhone(referralRaw) : null;
    const order = computeOrder();

    if (nombre.length < 2) return fail('Escribe tu nombre y apellidos.', $('nombre'));
    if (!phone) return fail('Revisa el teléfono: usa 9 cifras o el formato internacional (+34…).', $('telefono'));
    if (quantities.clasico + quantities.bocadillo === 0) return fail('Selecciona al menos un pandebono para tu pedido.');
    if (order.deliveryMethod === 'domicilio' && direccion.length < 5) return fail('Introduce tu dirección exacta en Premià de Mar.', $('direccion'));
    if (!hora) return fail('Selecciona una hora de entrega.', $('hora'));
    if (referralRaw && !referralCode) return fail('El código de referido debe ser un teléfono válido.', $('referido'));
    if (referralCode === phone) return fail('No puedes usar tu propio teléfono como código de referido.', $('referido'));

    submitBtn.disabled = true;
    submitBtn.textContent = 'Guardando pedido… ⏳';

    try {
        const orderData = {
            customerName: nombre,
            phone,
            items: { clasico: quantities.clasico, bocadillo: quantities.bocadillo },
            subtotalCents: order.subtotalCents,
            deliveryCents: order.deliveryCents,
            totalCents: order.totalCents,
            napaCount: order.napaCount,
            deliveryMethod: order.deliveryMethod,
            address: order.deliveryMethod === 'domicilio' ? direccion : 'Recogida en local',
            deliverySlot: hora,
            status: 'pending',
            createdAt: serverTimestamp()
        };
        if (referralCode) orderData.referralCode = referralCode;

        await addDoc(collection(db, 'orders'), orderData);

        const savedUser = storage.get('pachoncito_user') || {};
        storage.set('pachoncito_user', { ...savedUser, name: nombre, phone, address: direccion || savedUser.address || '' });
        storage.remove('pachoncito_ref');

        form.reset();
        setQty('clasico', 0);
        setQty('bocadillo', 0);
        prefill();
        $('referido').value = '';
        toggleDireccion();

        showMessage(message, `¡Pedido realizado con éxito, ${nombre}! Nos vemos este domingo 🥖🔥`, 'success');
        message.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
        console.error('Error al guardar el pedido:', error);
        fail('Hubo un error al procesar tu reserva. Revisa los datos e inténtalo de nuevo.');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = SUBMIT_LABEL;
    }
});

prefill();
toggleDireccion();
