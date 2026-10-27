import { collection, addDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { mountEnvBanner } from "./env.js";
import { mountFaq } from "./faq.js";
import { db } from "./firebase.js";
import { hydrateIcons } from "./icons.js";
import { buildOrder, priceOrder } from "./orders.js";
import { mountInstallPrompt, registerServiceWorker } from "./pwa.js";
import { requireCustomer } from "./session.js";
import { bump, initUI } from "./ui.js";
import { el, formatEUR, MAX_QTY, NAPA_EVERY_CENTS, PRICES_CENTS, showMessage, storage } from "./shared.js";

mountEnvBanner();
registerServiceWorker();
hydrateIcons();
mountFaq();
initUI();

// Auth wall: sin sesión o sin alta completa se redirige a acceso.html y se vuelve aquí después
const { session, profile } = await requireCustomer();

const $ = id => document.getElementById(id);
const form = $('orderForm');
const submitBtn = $('submitBtn');
const message = $('formMessage');
const SUBMIT_LABEL = submitBtn.textContent;
const quantities = { clasico: 0, bocadillo: 0 };

$('accountName').textContent = profile.name.split(' ')[0];
$('napaBalance').textContent = profile.napaCredits || 0;
mountInstallPrompt($('installSlot'));

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
    return { deliveryMethod, ...priceOrder(quantities, deliveryMethod) };
}

function updateSummary() {
    const { totalCents, napaCount } = computeOrder();
    const total = formatEUR(totalCents);
    if ($('totalPrice').textContent !== total) bump($('totalPrice'));
    $('totalPrice').textContent = total;

    const alertBox = $('napaAlert');
    alertBox.classList.toggle('is-success', napaCount > 0);
    if (napaCount > 0) {
        alertBox.replaceChildren(
            'Con este pedido te llevas ',
            el('strong', { text: `${napaCount} ${napaCount === 1 ? 'ñapa de regalo' : 'ñapas de regalo'}` }),
            ': pandebonos extra, invitación de la casa.'
        );
    } else {
        alertBox.textContent = `Te faltan ${formatEUR(NAPA_EVERY_CENTS - totalCents)} para llevarte una ñapa de regalo.`;
    }
}

function setQty(product, value) {
    const next = Math.min(MAX_QTY, Math.max(0, value));
    if (next !== quantities[product]) bump($(product));
    quantities[product] = next;
    $(product).textContent = next;
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

// Datos del expediente; el teléfono es siempre el vinculado a la cuenta (las reglas lo exigen)
function prefill() {
    const savedUser = storage.get('pachoncito_user') || {};
    $('nombre').value = profile.name || savedUser.name || '';
    $('telefono').value = profile.phone;
    $('direccion').value = savedUser.address || profile.address || '';
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
    const direccion = $('direccion').value.trim();
    const hora = $('hora').value;
    const order = computeOrder();

    if (nombre.length < 2) return fail('Escribe tu nombre y apellidos.', $('nombre'));
    if (quantities.clasico + quantities.bocadillo === 0) return fail('Selecciona al menos un pandebono para tu pedido.');
    if (order.deliveryMethod === 'domicilio' && direccion.length < 5) return fail('Introduce tu dirección exacta en Premià de Mar.', $('direccion'));
    if (!hora) return fail('Selecciona una hora de entrega.', $('hora'));

    submitBtn.disabled = true;
    submitBtn.textContent = 'Guardando pedido…';

    try {
        await addDoc(collection(db, 'orders'), buildOrder({
            uid: session.uid,
            name: nombre,
            phone: profile.phone,
            items: quantities,
            deliveryMethod: order.deliveryMethod,
            address: direccion,
            slot: hora,
            test: session.isTest
        }));

        const savedUser = storage.get('pachoncito_user') || {};
        storage.set('pachoncito_user', { ...savedUser, name: nombre, address: direccion || savedUser.address || '' });

        form.reset();
        setQty('clasico', 0);
        setQty('bocadillo', 0);
        prefill();
        toggleDireccion();

        showMessage(message, `Pedido reservado, ${nombre.split(' ')[0]}. Te esperamos el domingo; puedes seguirlo en «Mi cuenta».`, 'success');
        message.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
        console.error('Error al guardar el pedido:', error);
        fail('No hemos podido guardar tu pedido. Revisa la conexión y vuelve a intentarlo; si sigue fallando, escríbenos.');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = SUBMIT_LABEL;
    }
});

prefill();
toggleDireccion();
