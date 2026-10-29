import { addDoc, collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { mountEnvBanner } from "./env.js";
import { mountFaq } from "./faq.js";
import { db } from "./firebase.js";
import { hydrateIcons } from "./icons.js";
import { buildOrder, normalizeOrder, priceOrder } from "./orders.js";
import { mountInstallPrompt, registerServiceWorker } from "./pwa.js";
import { playReward, playSuccess, playTap } from "./sound.js";
import { requireCustomer } from "./session.js";
import { watchStore } from "./store.js";
import { bump, closeDialog, initUI, mountTopNav, nudge } from "./ui.js";
import { el, formatEUR, MAX_QTY, NAPA_EVERY_CENTS, PRICES_CENTS, PRODUCT_NAMES, showMessage, storage, validateMobile } from "./shared.js";

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
let lastNapaCount = 0;
const quantities = { clasico: 0, bocadillo: 0 };
const OPEN_STATUSES = ['pending', 'preparing', 'ready'];
let napasAvailable = 0;
let napasToRedeem = 0;
let storeOpen = true;      // settings/store: el obrador puede estar en descanso
let phoneBlocked = false;  // cuenta antigua con un teléfono que ya no es válido

mountTopNav(profile);
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

// Ñapas que puede canjear: su saldo menos las ya reservadas en pedidos aún sin entregar
async function loadAvailableNapas() {
    const balance = profile.napaCredits || 0;
    if (!balance) return 0;
    try {
        const snap = await getDocs(query(collection(db, 'orders'), where('uid', '==', session.uid)));
        const reserved = snap.docs.map(normalizeOrder)
            .filter(order => OPEN_STATUSES.includes(order.status))
            .reduce((sum, order) => sum + (order.creditsToRedeem ?? balance), 0);
        return Math.max(0, balance - reserved);
    } catch (error) {
        console.error('Error al consultar pedidos abiertos:', error);
        return balance;
    }
}

function renderNapaRedeem() {
    $('napaRedeem').hidden = napasAvailable === 0;
    $('napaRedeemQty').textContent = napasToRedeem;
    const kept = napasAvailable - napasToRedeem;
    $('napaRedeemHint').textContent = `Tienes ${napasAvailable} ${napasAvailable === 1 ? 'disponible' : 'disponibles'}`
        + (kept > 0 ? ` · te guardamos ${kept} para otro pedido` : '');
}

$('napaRedeem').addEventListener('click', event => {
    const button = event.target.closest('[data-redeem]');
    if (!button) return;
    const next = Math.min(napasAvailable, Math.max(0, napasToRedeem + Number(button.dataset.redeem)));
    if (next !== napasToRedeem) bump($('napaRedeemQty'));
    napasToRedeem = next;
    renderNapaRedeem();
});

function computeOrder() {
    const deliveryMethod = $('tipoEntrega').value;
    return { deliveryMethod, ...priceOrder(quantities, deliveryMethod) };
}

function updateSummary() {
    const { totalCents, napaCount } = computeOrder();
    const total = formatEUR(totalCents);
    if ($('totalPrice').textContent !== total) bump($('totalPrice'));
    $('totalPrice').textContent = total;

    // Suena solo al ganar una ñapa más, no al perderla ni al repintar
    if (napaCount > lastNapaCount) playReward();
    lastNapaCount = napaCount;

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
    const previous = quantities[product];
    const next = Math.min(MAX_QTY, Math.max(0, value));
    if (next !== previous) bump($(product));
    quantities[product] = next;
    $(product).textContent = next;
    const card = document.querySelector(`[data-card="${product}"]`);
    card.classList.toggle('is-selected', next > 0);
    if (next > previous) nudge(card);
}

form.addEventListener('click', event => {
    const button = event.target.closest('[data-product]');
    if (!button) return;
    const product = button.dataset.product;
    const before = quantities[product];
    setQty(product, before + Number(button.dataset.delta));
    if (quantities[product] > before) playTap();
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

// El botón de reservar solo se activa con el obrador abierto y un teléfono válido
function syncSubmit() {
    submitBtn.disabled = !storeOpen || phoneBlocked;
    submitBtn.textContent = storeOpen ? SUBMIT_LABEL : 'Reservas en pausa';
}

// Obrador en descanso: la carta se puede ver, pero contadores y reserva quedan desactivados
function renderStore(open) {
    storeOpen = open;
    $('closedBanner').hidden = open;
    form.classList.toggle('is-closed', !open);
    form.querySelectorAll('.counter button, #tipoEntrega, #hora, #direccion').forEach(control => { control.disabled = !open; });
    syncSubmit();
}

// Confirmación tras reservar, con el botón grande que lleva al seguimiento en vivo (Mi cuenta)
function showOrderDone({ orderId, firstName, items, order, slot, redeemed }) {
    const lines = Object.entries(PRODUCT_NAMES)
        .filter(([key]) => items[key] > 0)
        .map(([key, name]) => `${items[key]} × ${name}`);
    lines.push(`${order.deliveryMethod === 'domicilio' ? 'Envío a domicilio' : 'Recogida en el obrador'} · domingo a las ${slot}`);
    if (order.napaCount > 0) lines.push(`${order.napaCount} ${order.napaCount === 1 ? 'ñapa' : 'ñapas'} de regalo`);
    if (redeemed > 0) lines.push(`${redeemed} ${redeemed === 1 ? 'ñapa acumulada canjeada' : 'ñapas acumuladas canjeadas'}`);
    lines.push(`Total ${formatEUR(order.totalCents)} · efectivo o Bizum al recibirlo`);

    $('orderDoneLead').textContent = `Gracias, ${firstName}. Ya lo tenemos apuntado para el domingo.`;
    $('orderDoneSummary').replaceChildren(...lines.map(text => el('li', { text })));
    $('orderDoneTrack').href = `cuenta.html?pedido=${encodeURIComponent(orderId)}#historial`;
    $('orderDone').showModal();
}

$('orderDoneClose').addEventListener('click', () => closeDialog($('orderDone')));

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
    if (!storeOpen) return fail('El obrador descansa ahora mismo: no hay reservas activas. ¡Volvemos pronto!');
    if (quantities.clasico + quantities.bocadillo === 0) return fail('Selecciona al menos un pandebono para tu pedido.');
    if (order.deliveryMethod === 'domicilio' && direccion.length < 5) return fail('Introduce tu dirección exacta en Premià de Mar.', $('direccion'));
    if (!hora) return fail('Selecciona una hora de entrega.', $('hora'));

    submitBtn.disabled = true;
    submitBtn.textContent = 'Guardando pedido…';

    try {
        const items = { ...quantities };
        const redeemed = napasToRedeem;
        const ref = await addDoc(collection(db, 'orders'), buildOrder({
            uid: session.uid,
            name: nombre,
            phone: profile.phone,
            items: quantities,
            deliveryMethod: order.deliveryMethod,
            address: direccion,
            slot: hora,
            test: session.isTest,
            creditsToRedeem: napasToRedeem
        }));
        napasAvailable -= napasToRedeem;
        napasToRedeem = napasAvailable;
        renderNapaRedeem();

        const savedUser = storage.get('pachoncito_user') || {};
        storage.set('pachoncito_user', { ...savedUser, name: nombre, address: direccion || savedUser.address || '' });

        form.reset();
        setQty('clasico', 0);
        setQty('bocadillo', 0);
        prefill();
        toggleDireccion();

        playSuccess();
        showMessage(message, `Pedido reservado, ${nombre.split(' ')[0]}. Te esperamos el domingo; puedes seguirlo en «Mi cuenta».`, 'success');
        showOrderDone({ orderId: ref.id, firstName: nombre.split(' ')[0], items, order, slot: hora, redeemed });
    } catch (error) {
        console.error('Error al guardar el pedido:', error);
        fail(!storeOpen
            ? 'El obrador acaba de entrar en descanso: no hay reservas activas. ¡Volvemos pronto!'
            : 'No hemos podido guardar tu pedido. Revisa la conexión y vuelve a intentarlo; si sigue fallando, escríbenos.');
    } finally {
        syncSubmit();
    }
});

prefill();
toggleDireccion();

// Cuentas anteriores a la validación estricta: si su teléfono no es un móvil español real, no se puede reservar
// (las reglas también lo rechazan). Se avisa antes de que rellene el pedido.
if (!session.isTest && !validateMobile(profile.phone).phone) {
    phoneBlocked = true;
    syncSubmit();
    showMessage(message, 'El teléfono vinculado a tu cuenta no es un móvil español válido. Escríbenos por Instagram para corregirlo y poder reservar.', 'error');
}
watchStore(db, renderStore);
napasAvailable = await loadAvailableNapas();
napasToRedeem = napasAvailable;
renderNapaRedeem();
