import { collection, getDoc, getDocs, limit, query, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { composeAddress, mountAddressPicker, splitAddress } from "./address.js";
import { mountEnvBanner } from "./env.js";
import { mountFaq } from "./faq.js";
import { db } from "./firebase.js";
import { hydrateIcons } from "./icons.js";
import {
    buildOrder, missingWelcomeLocks, normalizeOrder, placeOrder, priceOrder, WELCOME_GIFT_LABEL, WELCOME_GIFT_PRODUCT, welcomeLockIds
} from "./orders.js";
import { notifyNewOrder } from "./notify.js";
import { addUnits, fits, maxPerOrder, orderUnits, ovenConfig, ovenLoadRef, SLOTS, slotsFor, sundayKeyFor, watchOvenLoad } from "./oven.js";
import { mountInstallPrompt, registerServiceWorker } from "./pwa.js";
import { playReward, playSuccess, playTap } from "./sound.js";
import { getCustomer, loginUrl } from "./session.js";
import { watchStore } from "./store.js";
import { bump, closeDialog, initUI, mountTopNav, nudge } from "./ui.js";
import { el, formatEUR, MAX_QTY, NAPA_EVERY_CENTS, PRICES_CENTS, PRODUCT_NAMES, showMessage, storage, validateMobile } from "./shared.js";

mountEnvBanner();
registerServiceWorker();
hydrateIcons();
mountFaq();
initUI();

// Carta pública: cualquiera la ve (también desde el navegador de Instagram), con fotos, precios y regalo.
// La cuenta solo se pide al pulsar «Reservar»: la cesta viaja en el enlace (?c=…&b=…) y se recupera al volver.
const customer = await getCustomer();
const guest = !customer;
const session = customer?.session ?? null;
const profile = customer?.profile ?? {};
document.documentElement.classList.toggle('is-guest', guest);
document.documentElement.classList.remove('auth-pending');

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

// Regalo de bienvenida: 1 clásico gratis en el primer pedido web. firestore.rules (validWelcomeGift) es quien decide;
// aquí solo se muestra cuando el cliente cumple las mismas condiciones.
const welcome = {
    active: false,       // settings/store.welcomeGift
    lockIds: guest ? [] : welcomeLockIds(session.uid, profile.phone, session.isTest),
    missing: null,       // cerrojos welcomeGifts que aún no existen (null = sin consultar o reglas antiguas)
    hasOrders: true      // ya tiene algún pedido web (hasta comprobarlo, se asume que sí)
};

if (guest) {
    // Visitante: la barra ofrece «Entrar» en lugar de su nombre y sus ñapas
    mountTopNav({ name: 'Entrar', napaCredits: 0 });
    const account = document.querySelector('.nav-account');
    account.href = loginUrl('index.html');
    account.setAttribute('aria-label', 'Entrar con tu cuenta');
    account.querySelector('.nav-napas')?.setAttribute('hidden', '');
    document.querySelectorAll('[data-member-only]').forEach(node => { node.hidden = true; });
    $('guestNote').hidden = false;
    // Enlace de invitación (index.html?ref=ANA-7K3P): se guarda para el alta, igual que en acceso.html
    const ref = (new URLSearchParams(location.search).get('ref') || '').toUpperCase();
    if (/^[A-Z]{3}-[A-Z2-9]{4}$/.test(ref)) storage.set('pachoncito_ref', ref);
} else {
    mountTopNav(profile);
}
mountInstallPrompt($('installSlot'));

// Precios visibles desde la misma fuente que usa el cálculo
document.querySelectorAll('[data-price]').forEach(node => {
    node.textContent = formatEUR(PRICES_CENTS[node.dataset.price]);
});

// Franjas de 30 minutos entre 06:00 y 17:30, limitadas por la capacidad del horno (oven.js)
SLOTS.forEach(slot => $('hora').append(new Option(slot, slot)));
let ovenCfg = ovenConfig();
let ovenLoad = {};
const ovenDay = sundayKeyFor();

// Pandebonos que hay que hornear para la cesta actual (pedidos + ñapas + regalo + ñapas canjeadas)
function cartUnits() {
    const { napaCount } = computeOrder();
    const hasItems = quantities.clasico + quantities.bocadillo > 0;
    return orderUnits({ items: quantities, napaCount, welcomeGift: hasItems && !guest && welcomeEligible(), creditsToRedeem: napasToRedeem });
}

// Marca como «completo» las horas en las que este pedido no cabe en el horno, contando los demás pedidos
function renderSlots() {
    const units = cartUnits();
    const options = slotsFor(ovenLoad, units, ovenCfg);
    let blocked = 0;
    options.forEach(({ slot, fits: ok }, i) => {
        const option = $('hora').options[i + 1];
        option.disabled = !ok;
        option.textContent = ok ? slot : `${slot} · completo`;
        if (!ok) blocked++;
    });
    const selected = $('hora').value;
    const lost = selected && !options.find(o => o.slot === selected)?.fits;
    if (lost) $('hora').value = '';
    const hint = $('horaHint');
    if (units > maxPerOrder(ovenCfg)) {
        hint.textContent = `Un pedido de ${units} pandebonos no nos cabe en el horno para una sola hora. Escríbenos por Instagram y lo organizamos.`;
    } else if (lost) {
        hint.textContent = `Las ${selected} ya no tienen horno libre para ${units} pandebonos: elige otra hora.`;
    } else if (blocked) {
        hint.textContent = units > ovenCfg.perSlot
            ? 'Tu pedido necesita más horno: las primeras horas y las que ya están llenas aparecen como «completo».'
            : 'Las horas marcadas como «completo» ya no tienen horno libre.';
    } else {
        hint.textContent = '';
    }
    hint.hidden = !hint.textContent;
}

// Pedidos web del cliente, o null si no se pudieron consultar
async function loadMyOrders() {
    if (guest) return [];
    try {
        const snap = await getDocs(query(collection(db, 'orders'), where('uid', '==', session.uid)));
        return snap.docs.map(normalizeOrder);
    } catch (error) {
        console.error('Error al consultar pedidos abiertos:', error);
        return null;
    }
}

// Ñapas que puede canjear: su saldo menos las ya reservadas en pedidos aún sin entregar
function availableNapas(myOrders) {
    const balance = profile.napaCredits || 0;
    if (!balance || !myOrders) return balance;
    const reserved = myOrders
        .filter(order => OPEN_STATUSES.includes(order.status))
        .reduce((sum, order) => sum + (order.creditsToRedeem ?? balance), 0);
    return Math.max(0, balance - reserved);
}

// Mismas condiciones que validWelcomeGift(): regalo activo, ningún pedido entregado (sin el campo cuenta como 0),
// ningún pedido web anterior y ninguno de sus cerrojos creado todavía
function welcomeEligible(missing = welcome.missing) {
    if (guest) return welcome.active; // visitante: se anuncia; la cuenta y las reglas deciden al reservar
    return welcome.active
        && !(profile.completedOrders > 0)
        && !welcome.hasOrders
        && Array.isArray(missing)
        && missing.length === welcome.lockIds.length;
}

function renderWelcomeGift() {
    const show = welcomeEligible();
    const hasItems = quantities.clasico + quantities.bocadillo > 0;
    $('welcomeGift').hidden = !show;
    $('welcomeGift').classList.toggle('is-included', show && hasItems && !guest);
    $('welcomeGiftHint').textContent = hasItems && !guest
        ? `1 × Pandebono ${PRODUCT_NAMES[WELCOME_GIFT_PRODUCT]} · va en este pedido`
        : `Tu primer pedido en la web lleva 1 pandebono ${PRODUCT_NAMES[WELCOME_GIFT_PRODUCT].toLowerCase()} gratis`;
    $('summaryGift').hidden = !(show && hasItems && !guest);
}

async function refreshWelcome() {
    if (guest) {
        renderWelcomeGift();
        return [];
    }
    const [missing, myOrders] = await Promise.all([missingWelcomeLocks(db, welcome.lockIds), loadMyOrders()]);
    welcome.missing = missing;
    welcome.hasOrders = myOrders === null || myOrders.length > 0;
    renderWelcomeGift();
    return myOrders;
}

function renderNapaRedeem() {
    $('napaRedeem').hidden = napasAvailable === 0;
    $('napaRedeemQty').textContent = napasToRedeem;
    const kept = napasAvailable - napasToRedeem;
    $('napaRedeemHint').textContent = `Tienes ${napasAvailable} ${napasAvailable === 1 ? 'disponible' : 'disponibles'}`
        + (kept > 0 ? ` · te guardamos ${kept} para otro pedido` : '');
    renderSlots();
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

    renderWelcomeGift();
    renderSlots();

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

// Dirección a domicilio: sugerencias de calles de Premià y alfiler para confirmar la puerta (address.js)
const addressPicker = mountAddressPicker({
    input: $('direccion'),
    list: $('direccionList'),
    mapBox: $('direccionMap'),
    hint: $('direccionHint')
});

function fullAddress() {
    return composeAddress($('direccion').value, $('direccionExtra').value);
}

function rememberAddress() {
    const savedUser = storage.get('pachoncito_user') || {};
    const street = $('direccion').value.trim();
    if (!street) return;
    storage.set('pachoncito_user', { ...savedUser, address: fullAddress(), point: addressPicker.point || null });
}

function toggleDireccion() {
    const isHome = $('tipoEntrega').value === 'domicilio';
    $('direccionBox').hidden = !isHome;
    $('direccion').required = isHome;
    if (isHome) addressPicker.refresh();
    updateSummary();
}

$('tipoEntrega').addEventListener('change', toggleDireccion);

// Datos del expediente; el teléfono es siempre el vinculado a la cuenta (las reglas lo exigen)
function prefill() {
    const savedUser = storage.get('pachoncito_user') || {};
    $('nombre').value = profile.name || savedUser.name || '';
    $('telefono').value = profile.phone || '';
    const { street, extra } = splitAddress(savedUser.address || profile.address || '');
    $('direccion').value = street;
    $('direccionExtra').value = extra;
    // El punto que confirmó la última vez, si la dirección no ha cambiado
    if (savedUser.point && savedUser.address && street) addressPicker.set(savedUser.point);
}

// El botón de reservar solo se activa con el obrador abierto y un teléfono válido
function syncSubmit() {
    submitBtn.disabled = !storeOpen || phoneBlocked;
    submitBtn.textContent = storeOpen ? SUBMIT_LABEL : 'Reservas en pausa';
}

// Obrador en descanso: la carta se puede ver, pero contadores y reserva quedan desactivados
function renderStore(open, { welcomeGift = false, data = {} } = {}) {
    storeOpen = open;
    welcome.active = welcomeGift;
    ovenCfg = ovenConfig(data);
    renderSlots();
    renderWelcomeGift();
    $('closedBanner').hidden = open;
    form.classList.toggle('is-closed', !open);
    form.querySelectorAll('.counter button, #tipoEntrega, #hora, #direccion, #direccionExtra').forEach(control => { control.disabled = !open; });
    syncSubmit();
}

// Confirmación tras reservar, con el botón grande que lleva al seguimiento en vivo (Mi cuenta)
function showOrderDone({ orderId, firstName, items, order, slot, redeemed, gift }) {
    const lines = Object.entries(PRODUCT_NAMES)
        .filter(([key]) => items[key] > 0)
        .map(([key, name]) => `${items[key]} × ${name}`);
    if (gift) lines.push(`1 × ${PRODUCT_NAMES[WELCOME_GIFT_PRODUCT]} · ${WELCOME_GIFT_LABEL} (gratis)`);
    lines.push(`${order.deliveryMethod === 'domicilio' ? 'Envío a domicilio' : 'Recogida en el obrador'} · domingo a las ${slot}`);
    if (order.napaCount > 0) lines.push(`${order.napaCount} ${order.napaCount === 1 ? 'ñapa' : 'ñapas'} de regalo`);
    if (redeemed > 0) lines.push(`${redeemed} ${redeemed === 1 ? 'ñapa acumulada canjeada' : 'ñapas acumuladas canjeadas'}`);
    lines.push(`Total ${formatEUR(order.totalCents)} · efectivo o Bizum al recibirlo`);

    $('orderDoneLead').textContent = `Gracias, ${firstName}. Ya lo tenemos apuntado para el domingo.`;
    $('orderDoneSummary').replaceChildren(...lines.map(text => el('li', { text })));
    $('orderDoneTrack').href = `seguimiento.html?pedido=${encodeURIComponent(orderId)}`;
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

    // Visitante: se guarda la cesta en el enlace y se pide entrar; al volver, la cesta le está esperando
    if (guest) {
        if (!storeOpen) return fail('El obrador descansa ahora mismo: no hay reservas activas. ¡Volvemos pronto!');
        if (quantities.clasico + quantities.bocadillo === 0) return fail('Selecciona al menos un pandebono para tu pedido.');
        const cart = new URLSearchParams({ c: quantities.clasico, b: quantities.bocadillo, e: order.deliveryMethod });
        if (hora) cart.set('h', hora);
        rememberAddress();
        location.href = loginUrl(`index.html?${cart}`);
        return;
    }

    if (nombre.length < 2) return fail('Escribe tu nombre y apellidos.', $('nombre'));
    if (!storeOpen) return fail('El obrador descansa ahora mismo: no hay reservas activas. ¡Volvemos pronto!');
    if (quantities.clasico + quantities.bocadillo === 0) return fail('Selecciona al menos un pandebono para tu pedido.');
    if (order.deliveryMethod === 'domicilio' && direccion.length < 5) return fail('Escribe tu calle y número en Premià de Mar.', $('direccion'));
    if (!hora) return fail('Selecciona una hora de entrega.', $('hora'));

    submitBtn.disabled = true;
    submitBtn.textContent = 'Guardando pedido…';

    let gift = false;
    try {
        const items = { ...quantities };
        const redeemed = napasToRedeem;
        // Cerrojos del regalo, consultados justo antes de guardar: el primer pedido web los crea, lleve o no regalo
        const missing = await missingWelcomeLocks(db, welcome.lockIds);
        welcome.missing = missing;
        gift = welcomeEligible(missing);
        // Punto exacto de entrega: el que confirmó en el mapa o, si no eligió sugerencia, el de la calle escrita
        const destination = order.deliveryMethod === 'domicilio' ? await addressPicker.resolve() : null;
        const orderData = buildOrder({
            uid: session.uid,
            name: nombre,
            phone: profile.phone,
            items: quantities,
            deliveryMethod: order.deliveryMethod,
            address: fullAddress(),
            destination,
            slot: hora,
            test: session.isTest,
            creditsToRedeem: napasToRedeem,
            welcomeGift: gift
        });
        // Horno: la hora tiene que seguir cabiendo con la carga más reciente (otro cliente pudo reservar a la vez)
        const units = orderUnits(orderData);
        const freshLoad = async () => {
            try { return (await getDoc(ovenLoadRef(db, ovenDay))).data()?.units || {}; } catch { return null; }
        };
        let latest = await freshLoad();
        if (latest && !fits(addUnits(latest, hora, units), ovenCfg)) {
            ovenLoad = latest;
            renderSlots();
            fail(`Justo ahora se ha llenado el horno a las ${hora}. Elige otra hora, por favor.`, $('hora'));
            return;
        }
        // Del intento más completo al más sencillo: con horno y cerrojos → horno recargado → sin horno (reglas
        // antiguas) → sin cerrojos (solo si no lleva regalo). Así ningún pedido válido se queda sin guardar.
        const attempts = [];
        if (latest) attempts.push(() => placeOrder(db, orderData, missing || [], { day: ovenDay, before: latest, units }));
        if (latest) attempts.push(async () => {
            latest = await freshLoad();
            if (!latest || !fits(addUnits(latest, hora, units), ovenCfg)) throw Object.assign(new Error('Horno lleno'), { code: 'oven-full' });
            return placeOrder(db, orderData, missing || [], { day: ovenDay, before: latest, units });
        });
        attempts.push(() => placeOrder(db, orderData, missing || []));
        if (!gift && missing?.length) attempts.push(() => placeOrder(db, orderData, []));
        let ref;
        for (let i = 0; i < attempts.length && !ref; i++) {
            try {
                ref = await attempts[i]();
            } catch (error) {
                if (error?.code === 'oven-full') {
                    renderSlots();
                    fail(`Justo ahora se ha llenado el horno a las ${hora}. Elige otra hora, por favor.`, $('hora'));
                    return;
                }
                if (error?.code !== 'permission-denied' || i === attempts.length - 1) throw error;
                console.warn('Reintentando el pedido de otra forma:', error);
            }
        }
        notifyNewOrder(orderData, { test: session.isTest });
        welcome.missing = [];
        welcome.hasOrders = true;
        napasAvailable -= napasToRedeem;
        napasToRedeem = napasAvailable;
        renderNapaRedeem();

        const savedUser = storage.get('pachoncito_user') || {};
        storage.set('pachoncito_user', { ...savedUser, name: nombre });
        if (order.deliveryMethod === 'domicilio') rememberAddress();

        form.reset();
        setQty('clasico', 0);
        setQty('bocadillo', 0);
        prefill();
        toggleDireccion();

        playSuccess();
        showMessage(message, `Pedido reservado, ${nombre.split(' ')[0]}. Te esperamos el domingo; puedes seguirlo en «Mi cuenta».`, 'success');
        showOrderDone({ orderId: ref.id, firstName: nombre.split(' ')[0], items, order, slot: hora, redeemed, gift });
    } catch (error) {
        console.error('Error al guardar el pedido:', error);
        if (gift && storeOpen && error?.code === 'permission-denied') {
            // El regalo ya no estaba disponible (otra pestaña, o el obrador lo pausó): se actualiza y no se guarda nada
            await refreshWelcome();
            fail('No hemos podido aplicar el regalo de bienvenida: ya no está disponible para tu cuenta. Revisa tu pedido y vuelve a reservar.');
            return;
        }
        fail(!storeOpen
            ? 'El obrador acaba de entrar en descanso: no hay reservas activas. ¡Volvemos pronto!'
            : 'No hemos podido guardar tu pedido. Revisa la conexión y vuelve a intentarlo; si sigue fallando, escríbenos.');
    } finally {
        syncSubmit();
    }
});

// Cesta guardada en el enlace (?c=2&b=1&e=domicilio&h=10:00): al volver de entrar, o desde «Abrir en Safari»
let repeated = false;
function restoreCart() {
    const params = new URLSearchParams(location.search);
    if (!params.has('c') && !params.has('b')) return false;
    setQty('clasico', parseInt(params.get('c'), 10) || 0);
    setQty('bocadillo', parseInt(params.get('b'), 10) || 0);
    if (['recogida', 'domicilio'].includes(params.get('e'))) $('tipoEntrega').value = params.get('e');
    const slot = params.get('h');
    if (slot && [...$('hora').options].some(option => option.value === slot)) $('hora').value = slot;
    repeated = params.get('r') === '1';
    ['c', 'b', 'e', 'h', 'r'].forEach(key => params.delete(key));
    const rest = params.toString();
    history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
    return quantities.clasico + quantities.bocadillo > 0;
}

prefill();
const cartRestored = restoreCart();
toggleDireccion();
if (cartRestored && !guest) {
    showMessage(message, repeated
        ? 'Hemos puesto lo mismo que en tu pedido anterior. Elige la hora de entrega: solo aparecen las que tienen horno libre.'
        : 'Tu cesta te estaba esperando. Revisa la hora de entrega y reserva.', 'success');
    requestAnimationFrame(() => (repeated ? $('hora') : $('submitBtn')).scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

// Cuentas anteriores a la validación estricta: si su teléfono no es un móvil español real, no se puede reservar
// (las reglas también lo rechazan). Se avisa antes de que rellene el pedido.
if (!guest && !session.isTest && !validateMobile(profile.phone).phone) {
    phoneBlocked = true;
    syncSubmit();
    showMessage(message, 'El teléfono vinculado a tu cuenta no es un móvil español válido. Escríbenos por Instagram para corregirlo y poder reservar.', 'error');
}
watchStore(db, renderStore);
loadRating();
watchOvenLoad(db, ovenDay, load => { ovenLoad = load; renderSlots(); });
napasAvailable = availableNapas(await refreshWelcome());
napasToRedeem = napasAvailable;
renderNapaRedeem();

// Nota media de las reseñas verificadas en la cabecera (confianza para quien llega nuevo). Con menos de 3, no se muestra.
async function loadRating() {
    try {
        const snap = await getDocs(query(collection(db, 'reviews'), where('test', '==', false), limit(100)));
        const reviews = snap.docs.map(d => d.data()).filter(r => r.ratings);
        if (reviews.length < 3) return;
        const avg = reviews.reduce((sum, r) => sum + ((r.ratings.producto || 0) + (r.ratings.entrega || 0) + (r.ratings.atencion || 0)) / 3, 0) / reviews.length;
        const badge = $('ratingBadge');
        badge.textContent = `★ ${avg.toFixed(1).replace('.', ',')} · ${reviews.length} reseñas de clientes`;
        badge.setAttribute('aria-label', `Nota media ${avg.toFixed(1)} de 5 en ${reviews.length} reseñas. Ver reseñas`);
        badge.hidden = false;
    } catch (error) {
        console.warn('No se pudieron leer las reseñas:', error);
    }
}
