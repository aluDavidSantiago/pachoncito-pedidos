// Panel del obrador. Usa SU PROPIA instancia de Firebase (admin-firebase.js): la sesión de email y contraseña
// del obrador nunca se mezcla con la sesión de Google de un cliente en el mismo navegador.
import {
    collection, deleteDoc, doc, getDoc, limit, onSnapshot, orderBy, query,
    runTransaction, serverTimestamp, updateDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    biometricAvailable, biometricErrorMessage, biometricLabel, biometricOfferDeclined, declineBiometricOffer,
    enrollBiometric, forgetBiometric, getEnrollment, isUnlocked, lockPanel, markUnlocked, verifyBiometric
} from "./admin-biometric.js";
import {
    ensureCostData, importCatalog, parseEuros, UNITS_PER_BATCH, renderCostMonitor, renderShoppingList, unitCosts,
    updateCostSettings, updateIngredientSpec, updatePackPrice, watchCostData
} from "./admin-cost-monitor.js";
import { adminAuth, adminDb as db } from "./admin-firebase.js";
import { mountEnvBanner, TEST_CUSTOMERS, TEST_PHONES_LABEL, USE_EMULATORS } from "./env.js";
import { hydrateIcons, icon } from "./icons.js";
import { completeOrder, normalizeOrder } from "./orders.js";
import { clearTestData, seedTestData } from "./seeder.js";
import { setStoreOpen, watchStore } from "./store.js";
import { el, formatDate, formatEUR, normalizePhone, PRODUCT_NAMES, RATING_ASPECTS, showMessage, starsText, withBusy } from "./shared.js";
import { closeDialog, initUI, toast } from "./ui.js";

// Única cuenta admitida en el panel. La autorización real la da el documento admins/{uid} (firestore.rules).
const ADMIN_EMAIL = 'ds2.6hc@gmail.com';

mountEnvBanner();
hydrateIcons();
initUI();
const $ = id => document.getElementById(id);

const STATUS = {
    pending: { text: 'Pendiente', action: 'Pendiente', className: 'status-pending' },
    preparing: { text: 'En preparación', action: 'Preparando', className: 'status-preparing' },
    ready: { text: 'Listo', action: 'Listo', className: 'status-ready' },
    completed: { text: 'Entregado', action: 'Entregado', className: 'status-completed' },
    rejected: { text: 'Cancelado', action: 'Cancelar', className: 'status-rejected' }
};

const TABS = {
    pendientes: ['pending', 'preparing'],
    listos: ['ready'],
    completados: ['completed'],
    cancelados: ['rejected']
};

let orders = [];
let customers = new Map(); // uid → expediente
let reviews = [];
let costData = null;
let unsubscribers = [];
const filters = { sunday: currentSundayKey(), tab: 'pendientes', search: '' };

// ---------- Vistas ----------

function showView(view) {
    $('authStatus').hidden = view !== 'loading';
    $('loginView').hidden = view !== 'login';
    $('lockView').hidden = view !== 'lock';
    $('dashboard').hidden = view !== 'dashboard';
    $('logoutBtn').hidden = view !== 'dashboard';
    if (view !== 'dashboard') {
        $('lockBtn').hidden = true;
        $('biometricToggleBtn').hidden = true;
    }
}

function showLoginView(message) {
    showView('login');
    $('adminEmail').value ||= ADMIN_EMAIL;
    showMessage($('loginMessage'), message || '', 'error');
    biometricAvailable().then(available => { $('biometricLoginHint').hidden = !available; });
}

// Icono y textos de la biometría del dispositivo (Face ID, Touch ID, huella…)
function applyBiometricLabels() {
    const label = biometricLabel();
    const iconName = label === 'Face ID' ? 'faceid' : 'fingerprint';
    document.querySelectorAll('.lock-glyph .icon, .btn-biometric .icon').forEach(node => {
        node.replaceWith(icon(iconName, node.getAttribute('class')));
    });
    $('biometricLoginLabel').textContent = `Entrar con ${label}`;
    $('lockDesc').textContent = `Desbloquéalo con ${label} para ver los pedidos.`;
    $('biometricOfferTitle').textContent = `¿Activar ${label}?`;
    $('biometricOfferText').textContent = `Accede más rápido al panel: tu sesión se quedará en este dispositivo y se desbloqueará con ${label}.`;
    $('biometricLoginHint').textContent = `Tras entrar con tu contraseña en este dispositivo podrás desbloquear el panel con ${label}.`;
}
applyBiometricLabels();

// ---------- Acceso manual (email y contraseña) ----------

function loginErrorMessage(error) {
    switch (error?.code) {
        case 'auth/invalid-credential':
        case 'auth/invalid-email':
        case 'auth/wrong-password':
        case 'auth/user-not-found': return 'Email o contraseña incorrectos.';
        case 'auth/too-many-requests': return 'Demasiados intentos. Espera unos minutos.';
        default: return 'No se pudo iniciar sesión. Revisa la conexión.';
    }
}

$('loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const email = $('adminEmail').value.trim().toLowerCase();
    const password = $('adminPassword').value;
    if (!email || !password) {
        showMessage($('loginMessage'), 'Introduce email y contraseña.', 'error');
        return;
    }
    if (email !== ADMIN_EMAIL) {
        showMessage($('loginMessage'), 'Este panel solo admite la cuenta del obrador.', 'error');
        return;
    }
    try {
        markUnlocked(); // quien acaba de escribir la contraseña no necesita además Face ID
        await withBusy(event.submitter, 'Entrando…', () => signInWithEmailAndPassword(adminAuth, email, password));
        $('adminPassword').value = '';
    } catch (error) {
        lockPanel();
        showMessage($('loginMessage'), loginErrorMessage(error), 'error');
    }
});

$('logoutBtn').addEventListener('click', () => {
    lockPanel();
    signOut(adminAuth);
});

// ---------- Bloqueo y desbloqueo biométrico ----------

$('lockBtn').addEventListener('click', () => {
    lockPanel();
    stopListeners();
    showView('lock');
});

$('biometricLoginBtn').addEventListener('click', async event => {
    const user = adminAuth.currentUser;
    const enrollment = getEnrollment(user?.uid);
    if (!user || !enrollment) {
        showLoginView();
        return;
    }
    try {
        await withBusy(event.currentTarget, 'Verificando…', () => verifyBiometric(enrollment));
        showMessage($('lockMessage'), '');
        enterDashboard(user);
    } catch (error) {
        showMessage($('lockMessage'), biometricErrorMessage(error), 'error');
    }
});

$('usePasswordBtn').addEventListener('click', () => {
    lockPanel();
    signOut(adminAuth); // cierra la sesión guardada: se vuelve a entrar con contraseña
});

async function updateBiometricControls(user) {
    const available = await biometricAvailable();
    const enrolled = Boolean(getEnrollment(user.uid));
    const toggle = $('biometricToggleBtn');
    toggle.hidden = !available;
    toggle.replaceChildren(icon(biometricLabel() === 'Face ID' ? 'faceid' : 'fingerprint'),
        enrolled ? `${biometricLabel()} activado` : `Activar ${biometricLabel()}`);
    toggle.classList.toggle('is-active', enrolled);
    $('lockBtn').hidden = !enrolled;
    return { available, enrolled };
}

async function startEnrollment(user) {
    try {
        await enrollBiometric(user);
        toast(`${biometricLabel()} activado: la próxima vez desbloquearás el panel al instante.`, 'success');
    } catch (error) {
        toast(biometricErrorMessage(error), 'error');
    }
    updateBiometricControls(user);
}

$('biometricToggleBtn').addEventListener('click', () => {
    const user = adminAuth.currentUser;
    if (!user) return;
    if (getEnrollment(user.uid)) {
        if (!confirm(`¿Desactivar ${biometricLabel()} en este dispositivo?`)) return;
        forgetBiometric();
        markUnlocked();
        updateBiometricControls(user);
        toast(`${biometricLabel()} desactivado en este dispositivo.`);
    } else {
        startEnrollment(user); // directamente en el gesto del usuario (lo exige Safari)
    }
});

$('biometricOfferYes').addEventListener('click', () => {
    const user = adminAuth.currentUser;
    closeDialog($('biometricOffer'));
    if (user) startEnrollment(user);
});

$('biometricOfferNo').addEventListener('click', () => {
    declineBiometricOffer();
    closeDialog($('biometricOffer'));
});

// ---------- Sesión ----------

onAuthStateChanged(adminAuth, async user => {
    stopListeners();
    if (!user) {
        showLoginView();
        return;
    }
    if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) {
        await signOut(adminAuth);
        showLoginView('Este panel solo admite la cuenta del obrador.');
        return;
    }

    showView('loading');
    let isAdmin = false;
    try {
        isAdmin = (await getDoc(doc(db, 'admins', user.uid))).exists();
    } catch (error) {
        console.error('Error comprobando permisos:', error);
    }
    if (!isAdmin) {
        await signOut(adminAuth);
        showLoginView('Esta cuenta no tiene permisos de administración.');
        return;
    }

    // Con Face ID activado, la sesión guardada abre el panel bloqueado hasta verificar
    if (getEnrollment(user.uid) && !isUnlocked()) {
        showMessage($('lockMessage'), '');
        showView('lock');
        return;
    }
    enterDashboard(user);
});

async function enterDashboard(user) {
    showMessage($('loginMessage'), '');
    showView('dashboard');
    startListeners();
    const { available, enrolled } = await updateBiometricControls(user);
    if (available && !enrolled && !biometricOfferDeclined()) $('biometricOffer').showModal();
}

// ---------- Datos en tiempo real ----------

function startListeners() {
    if (unsubscribers.length) return;
    const onError = error => {
        console.error('Error de Firestore:', error);
        toast('Se perdió la conexión con la base de datos o faltan permisos.', 'error');
    };

    unsubscribers = [
        onSnapshot(query(collection(db, 'orders'), orderBy('createdAt', 'desc')), snap => {
            orders = snap.docs.map(normalizeOrder);
            renderAll();
        }, onError),
        onSnapshot(collection(db, 'customers'), snap => {
            customers = new Map(snap.docs.map(d => [d.id, d.data()]));
            renderAll();
        }, onError),
        onSnapshot(query(collection(db, 'reviews'), orderBy('createdAt', 'desc'), limit(100)), snap => {
            reviews = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            renderReviews();
        }, onError),
        watchStore(db, renderStoreStatus, onError)
    ];

    ensureCostData(db)
        .then(() => {
            if (!unsubscribers.length) return; // se cerró la sesión mientras tanto
            unsubscribers.push(...watchCostData(db, data => {
                costData = data;
                renderCosts();
                renderProduction();
            }, onError));
        })
        .catch(error => {
            console.error('Error preparando los costes:', error);
            $('costMonitor').replaceChildren(el('p', {
                className: 'empty-state',
                text: 'No se pudieron cargar los costes. ¿Has desplegado las reglas nuevas (ingredients y settings)?'
            }));
        });
}

// ---------- Estado del obrador (abierto / descanso) ----------

function renderStoreStatus(open) {
    const toggle = $('storeOpenToggle');
    toggle.checked = open;
    toggle.disabled = false;
    $('storeStatus').dataset.open = String(open);
    $('storeStatusLabel').textContent = open ? 'abierto' : 'en descanso';
    $('storeStatusHint').textContent = open
        ? 'Los clientes pueden reservar.'
        : 'La carta se ve, pero las reservas están en pausa.';
}

$('storeOpenToggle').addEventListener('change', async event => {
    const toggle = event.target;
    const open = toggle.checked;
    toggle.disabled = true;
    try {
        await setStoreOpen(db, open);
        toast(open ? 'Obrador abierto: ya se puede reservar.' : 'Obrador en descanso: reservas en pausa.', 'success');
    } catch (error) {
        console.error('Error al cambiar el estado del obrador:', error);
        toggle.checked = !open;
        toast('No se pudo cambiar el estado del obrador.', 'error');
    } finally {
        toggle.disabled = false;
    }
});

function stopListeners() {
    unsubscribers.forEach(unsubscribe => unsubscribe());
    unsubscribers = [];
    orders = [];
    customers = new Map();
    reviews = [];
    costData = null;
}

function renderAll() {
    renderSundayOptions();
    renderProduction();
    renderOrders();
}

// ---------- Domingos de entrega ----------

// Declaraciones de función (no const): `filters` las usa al cargar el módulo, antes de esta línea
function pad(n) {
    return String(n).padStart(2, '0');
}

function dateKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Se reserva de lunes a viernes para el domingo siguiente (un pedido hecho en domingo es para el siguiente)
function sundayKeyFor(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + (d.getDay() === 0 ? 7 : 7 - d.getDay()));
    return dateKey(d);
}

// Domingo en curso: hoy si es domingo; si no, el próximo
function currentSundayKey() {
    const today = new Date();
    return today.getDay() === 0 ? dateKey(today) : sundayKeyFor(today);
}

const orderSunday = order => sundayKeyFor(order.createdAt?.toDate?.() ?? new Date());

function sundayLabel(key) {
    const label = new Date(`${key}T12:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
    return key === currentSundayKey() ? `Este domingo · ${label}` : `Domingo ${label}`;
}

function renderSundayOptions() {
    const keys = [...new Set([currentSundayKey(), ...orders.map(orderSunday)])].sort().reverse();
    const select = $('sundaySelect');
    select.replaceChildren(
        ...keys.map(key => new Option(sundayLabel(key), key, false, key === filters.sunday)),
        new Option('Todos los domingos', 'all', false, filters.sunday === 'all')
    );
}

$('sundaySelect').addEventListener('change', event => {
    filters.sunday = event.target.value;
    renderProduction();
    renderOrders();
});

const ordersOfSunday = () => (filters.sunday === 'all' ? orders : orders.filter(o => orderSunday(o) === filters.sunday));

// ---------- Producción y finanzas del domingo ----------

const customerOf = order => (order.uid ? customers.get(order.uid) : null);

// Ñapas acumuladas (invitaciones / feedback) que se entregan con cada pedido. El cliente elige cuántas canjear
// (creditsToRedeem); en pedidos antiguos sin esa elección se entregan todas. Si tiene varios pedidos abiertos,
// su saldo se reparte del más antiguo al más reciente, igual que se descontará al entregarlos.
function creditsByOrder(list) {
    const remaining = new Map();
    const result = new Map();
    for (const order of [...list].reverse()) {
        if (order.status === 'completed') {
            result.set(order.id, order.creditsRedeemed || 0);
            continue;
        }
        if (order.status === 'rejected' || !order.uid) continue;
        const left = remaining.has(order.uid) ? remaining.get(order.uid) : (customerOf(order)?.napaCredits || 0);
        const credits = Math.min(order.creditsToRedeem ?? left, left);
        remaining.set(order.uid, left - credits);
        result.set(order.id, credits);
    }
    return result;
}

let orderCredits = new Map();

// Estados que ya salieron del horno: «Listo» y «Entregado». Pendiente y En preparación faltan por hornear.
const BAKED = ['ready', 'completed'];

function productionOf(list) {
    const p = { clasicos: 0, bocadillos: 0, napas: 0, units: 0, pendingUnits: 0, bakedUnits: 0, ingresosCents: 0 };
    for (const order of list) {
        if (order.status === 'rejected') continue;
        const clasicos = order.items?.clasico || 0;
        const bocadillos = order.items?.bocadillo || 0;
        const napas = order.napaCount + (orderCredits.get(order.id) || 0);
        const units = clasicos + bocadillos + napas;
        p.clasicos += clasicos;
        p.bocadillos += bocadillos;
        p.napas += napas;
        p.units += units;
        p[BAKED.includes(order.status) ? 'bakedUnits' : 'pendingUnits'] += units;
        p.ingresosCents += order.totalCents;
    }
    return p;
}

function renderProduction() {
    // El reparto de ñapas se calcula sobre todos los pedidos: el saldo de un cliente es uno solo
    orderCredits = creditsByOrder(orders);
    const p = productionOf(ordersOfSunday());
    // Se hornea por tandas completas de 8: lo que sobra de la última tanda queda como excedente
    const batches = Math.ceil(p.pendingUnits / UNITS_PER_BATCH);
    const spare = batches * UNITS_PER_BATCH - p.pendingUnits;
    // Las ñapas son pandebonos clásicos de regalo: cuentan como coste, no como ingreso
    const costs = costData ? unitCosts(costData) : null;
    const costCents = costs ? (p.clasicos + p.napas) * costs.clasico + p.bocadillos * costs.bocadillo : 0;

    $('kpiPendientes').textContent = p.pendingUnits;
    $('kpiHorneados').textContent = p.bakedUnits;
    $('kpiBatches').textContent = batches
        ? `${batches} ${batches === 1 ? 'tanda' : 'tandas'} × ${UNITS_PER_BATCH} = ${batches * UNITS_PER_BATCH} panes${spare ? ` (${spare} de excedente)` : ''}`
        : 'Nada pendiente de hornear';
    $('kpiTotalDia').textContent = `de ${p.units} en total`;
    $('kpiClasicos').textContent = p.clasicos;
    $('kpiBocadillo').textContent = p.bocadillos;
    $('kpiNapas').textContent = p.napas;
    $('kpiIngresos').textContent = formatEUR(p.ingresosCents);
    $('kpiCoste').textContent = costs ? formatEUR(Math.round(costCents)) : '—';
    $('kpiBeneficio').textContent = costs ? formatEUR(Math.round(p.ingresosCents - costCents)) : '—';

    if (costData) renderShoppingList($('listaCompraBox'), costData, { units: p.units, bocadillos: p.bocadillos });
}

// ---------- Encargos: pestañas, buscador y tarjetas ----------

function matchesSearch(order) {
    const q = filters.search.trim().toLowerCase();
    if (!q) return true;
    const digits = q.replace(/\D/g, '');
    return (order.customerName || '').toLowerCase().includes(q)
        || (digits.length >= 3 && (order.phone || '').replace(/\D/g, '').includes(digits));
}

function renderTabs(list) {
    for (const [tab, statuses] of Object.entries(TABS)) {
        document.querySelector(`[data-count="${tab}"]`).textContent = list.filter(o => statuses.includes(o.status)).length;
    }
    const buttons = [...document.querySelectorAll('#statusTabs [data-tab]')];
    buttons.forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === filters.tab)));
    $('statusTabs').style.setProperty('--tab-index', buttons.findIndex(b => b.dataset.tab === filters.tab));
}

document.querySelectorAll('#statusTabs [data-tab]').forEach(button => {
    button.addEventListener('click', () => {
        filters.tab = button.dataset.tab;
        renderOrders();
    });
});

$('orderSearch').addEventListener('input', event => {
    filters.search = event.target.value;
    renderOrders();
});

function metaLine(...parts) {
    return el('p', {}, ...parts);
}

function orderCard(order) {
    const status = STATUS[order.status] || STATUS.pending;
    const isClosed = order.status === 'completed';
    const credits = orderCredits.get(order.id) || 0;
    const customer = customerOf(order);
    const phoneNode = order.phoneKey
        ? el('a', { className: 'order-phone', href: `tel:${order.phoneKey}`, text: order.phone })
        : el('span', { className: 'order-phone', text: order.phone || 'Sin teléfono' });

    const meta = el('div', { className: 'order-meta' },
        metaLine(el('strong', { text: 'Clásicos:' }), ` ${order.items?.clasico || 0} · `,
            el('strong', { text: 'Bocadillo:' }), ` ${order.items?.bocadillo || 0}`),
        metaLine(el('strong', { text: 'Entrega:' }), ' ',
            order.deliveryMethod === 'domicilio' ? `A domicilio — ${order.address}` : 'Recogida en el obrador'),
        metaLine(el('strong', { text: 'Hora:' }), ` ${order.deliverySlot || '—'} · `,
            el('strong', { text: 'Total:' }), ` ${formatEUR(order.totalCents)}`),
        order.createdAt ? metaLine(`Reservado el ${formatDate(order.createdAt)}`) : null,
        !order.uid
            ? el('p', { className: 'meta-accent', text: 'Pedido anterior a las cuentas de cliente' })
            : el('p', {
                className: customer?.phoneVerified ? 'meta-success' : 'meta-accent',
                text: customer?.phoneVerified ? 'Teléfono confirmado' : 'Teléfono sin confirmar: compruébalo al entregar'
            }),
        order.napaCount > 0
            ? el('p', { className: 'meta-success', text: `Incluye ${order.napaCount} ${order.napaCount === 1 ? 'ñapa' : 'ñapas'} por volumen de compra` })
            : null,
        credits > 0
            ? el('p', {
                className: 'meta-success',
                text: isClosed
                    ? `Se entregaron ${credits} ${credits === 1 ? 'ñapa acumulada' : 'ñapas acumuladas'} (invitaciones / reseñas)`
                    : `+${credits} ${credits === 1 ? 'ñapa acumulada' : 'ñapas acumuladas'} (invitaciones / reseñas): entrégalas en este pedido`
                        + (order.creditsToRedeem !== null && (customer?.napaCredits || 0) > credits
                            ? ` · se le guardan ${(customer.napaCredits || 0) - credits}` : '')
            })
            : null,
        customer?.referredByCode && !customer.completedOrders
            ? el('p', { className: 'meta-accent', text: `Invitado con el código ${customer.referredByCode}: su recomendador gana una ñapa al entregar este primer pedido` })
            : null,
        order.referralRewarded
            ? el('p', { className: 'meta-success', text: 'Ñapa de invitación concedida al recomendador' })
            : null
    );

    const actions = el('div', { className: 'actions-bar' },
        Object.entries(STATUS).map(([key, info]) => el('button', {
            type: 'button',
            className: `btn btn-small${key === 'rejected' ? ' btn-danger' : ''}`,
            disabled: isClosed || key === order.status,
            onClick: event => changeStatus(order, key, event.currentTarget)
        }, info.action)),
        el('button', {
            type: 'button',
            className: 'btn btn-small btn-danger',
            onClick: () => deleteOrder(order.id)
        }, 'Borrar')
    );

    return el('article', { className: 'order-card' },
        el('div', { className: 'order-info' },
            el('h3', {}, order.customerName || 'Sin nombre', phoneNode,
                order.test ? el('span', { className: 'test-tag', text: 'Prueba' }) : null),
            meta,
            actions
        ),
        el('span', { className: `badge-status ${status.className}`, text: status.text })
    );
}

function renderOrders() {
    const searched = ordersOfSunday().filter(matchesSearch);
    renderTabs(searched);
    const visible = searched.filter(o => TABS[filters.tab].includes(o.status));
    const container = $('ordersContainer');
    if (!visible.length) {
        const empty = filters.search ? 'Ningún encargo coincide con la búsqueda.' : 'No hay encargos en esta pestaña.';
        container.replaceChildren(el('p', { className: 'empty-state', text: empty }));
        return;
    }
    container.replaceChildren(...visible.map(orderCard));
}

async function changeStatus(order, newStatus, button) {
    try {
        if (newStatus === 'completed') {
            const ok = confirm(`¿Marcar como entregado?\n\nAl hacerlo confirmas que el teléfono ${order.phone || ''} es de este cliente. `
                + 'Se registrará su compra, se canjearán las ñapas acumuladas que eligió (el resto se le guarda) y, si es su primer pedido y vino invitado, '
                + 'su recomendador ganará una ñapa. No se puede deshacer.');
            if (!ok) return;
            const result = await withBusy(button, '…', () => completeOrder(db, order.id));
            if (result) {
                const notes = ['Pedido entregado y registrado.'];
                if (result.creditsRedeemed) notes.push(`Ñapas acumuladas canjeadas: ${result.creditsRedeemed}.`);
                if (result.referrerRewarded) notes.push('El recomendador ha ganado una ñapa.');
                if (result.legacyMerged) notes.push('Se ha fusionado su historial anterior.');
                if (result.warning) notes.push(result.warning);
                toast(notes.join(' '), result.warning ? 'info' : 'success');
            }
        } else {
            await updateDoc(doc(db, 'orders', order.id), { status: newStatus });
            toast(`${order.customerName || 'Pedido'}: ${STATUS[newStatus].text.toLowerCase()}.`, 'success');
        }
    } catch (error) {
        console.error('Error al actualizar estado:', error);
        toast('No se pudo actualizar el pedido.', 'error');
    }
}

async function deleteOrder(orderId) {
    if (!confirm('¿Seguro que quieres eliminar este pedido permanentemente?')) return;
    try {
        await deleteDoc(doc(db, 'orders', orderId));
        toast('Pedido eliminado.');
    } catch (error) {
        console.error('Error al eliminar pedido:', error);
        toast('No se pudo eliminar el pedido.', 'error');
    }
}

// ---------- Monitor de costes ----------

const costHandlers = {
    async onPrice(ingredient, input) {
        const cents = parseEuros(input.value);
        if (cents === null) {
            toast('Introduce un precio válido (por ejemplo 1,95).', 'error');
            return;
        }
        if (cents === ingredient.packPriceCents) {
            toast(`${ingredient.name}: el precio no ha cambiado.`);
            return;
        }
        try {
            await updatePackPrice(db, ingredient, cents);
            toast(`${ingredient.name}: ${formatEUR(ingredient.packPriceCents ?? 0)} → ${formatEUR(cents)}`, 'success');
        } catch (error) {
            console.error('Error al actualizar el precio:', error);
            toast('No se pudo guardar el precio.', 'error');
        }
    },
    async onSpec(ingredient, amountInput, usageInput) {
        const packAmount = parseFloat(String(amountInput.value).replace(',', '.'));
        const usageRaw = String(usageInput.value).trim();
        const usage = usageRaw === '' ? null : parseFloat(usageRaw.replace(',', '.'));
        if (!(packAmount > 0) || (usage !== null && !(usage >= 0))) {
            toast('Revisa el contenido del envase y la cantidad usada.', 'error');
            return;
        }
        try {
            await updateIngredientSpec(db, ingredient, { packAmount, usage });
            toast(`${ingredient.name}: formato y receta guardados.`, 'success');
        } catch (error) {
            console.error('Error al guardar el formato:', error);
            toast('No se pudo guardar.', 'error');
        }
    },
    async onSettings(otherInput) {
        const otherPerBatchCents = parseEuros(otherInput.value);
        if (otherPerBatchCents === null) {
            toast('Revisa el importe.', 'error');
            return;
        }
        try {
            await updateCostSettings(db, { otherPerBatchCents });
            toast('Costes generales guardados.', 'success');
        } catch (error) {
            console.error('Error al guardar los ajustes:', error);
            toast('No se pudo guardar.', 'error');
        }
    }
};

$('catalogFile').addEventListener('change', async event => {
    const input = event.target;
    const file = input.files?.[0];
    input.value = ''; // permite volver a elegir el mismo archivo
    if (!file) return;
    try {
        const { created, completed, total } = await importCatalog(db, await file.text());
        toast(created || completed
            ? `Catálogo importado: ${created} ingredientes nuevos y ${completed} completados (de ${total}).`
            : 'El catálogo ya estaba al día: no había nada que importar.', 'success');
    } catch (error) {
        console.error('Error al importar el catálogo:', error);
        toast(error.message || 'No se pudo importar el catálogo.', 'error');
    }
});

function renderCosts() {
    if (costData) renderCostMonitor($('costMonitor'), costData, costHandlers);
}

// ---------- Reseñas ----------

function reviewCard(review) {
    const scores = RATING_ASPECTS
        .map(([key, label]) => `${label} ${starsText(review.ratings?.[key])}`)
        .join(' · ');

    return el('article', { className: 'order-card' },
        el('div', { className: 'order-info' },
            el('h3', {}, PRODUCT_NAMES[review.product] || review.product,
                review.test ? el('span', { className: 'test-tag', text: 'Prueba' }) : null),
            el('p', { className: 'order-meta stars-static', text: scores }),
            review.comment ? el('p', { className: 'review-comment', text: review.comment }) : null,
            el('p', { className: 'order-meta', text: formatDate(review.createdAt) }),
            review.rewarded ? el('p', { className: 'meta-success', text: 'Reseña recompensada' }) : null,
            el('div', { className: 'actions-bar' },
                review.rewarded ? null : el('button', {
                    type: 'button',
                    className: 'btn btn-small',
                    onClick: event => rewardReview(review.id, event.currentTarget)
                }, icon('gift'), 'Dar ñapa por feedback'),
                el('button', {
                    type: 'button',
                    className: 'btn btn-small btn-danger',
                    onClick: () => deleteReview(review.id)
                }, 'Eliminar')
            )
        )
    );
}

function renderReviews() {
    const container = $('reviewsContainer');
    if (!reviews.length) {
        container.replaceChildren(el('p', { className: 'empty-state', text: 'Todavía no hay reseñas.' }));
        return;
    }
    container.replaceChildren(...reviews.map(reviewCard));
}

// Recompensa manual para reseñas antiguas sin ñapa (las nuevas ya llevan la suya: 1 por pedido entregado valorado).
// Solo con el teléfono confirmado (evita multicuenta).
async function rewardReview(reviewId, button) {
    try {
        const outcome = await withBusy(button, '…', () => runTransaction(db, async tx => {
            const reviewRef = doc(db, 'reviews', reviewId);
            const reviewSnap = await tx.get(reviewRef);
            const authorSnap = await tx.get(doc(db, 'reviewAuthors', reviewId));
            if (!reviewSnap.exists() || reviewSnap.data().rewarded) return 'already';

            const authorUid = authorSnap.exists() ? authorSnap.data().uid : null;
            const customerRef = authorUid ? doc(db, 'customers', authorUid) : null;
            const customerSnap = customerRef ? await tx.get(customerRef) : null;
            if (!customerSnap?.exists()) return 'no-customer';
            const customer = customerSnap.data();
            if (!customer.phoneVerified) return 'not-verified';

            tx.update(reviewRef, { rewarded: true });
            tx.update(customerRef, {
                napaCredits: (customer.napaCredits || 0) + 1,
                updatedAt: serverTimestamp()
            });
            return 'rewarded';
        }));

        const messages = {
            rewarded: ['Ñapa añadida: se entregará en el próximo pedido del cliente.', 'success'],
            'not-verified': ['El teléfono de este cliente aún no está confirmado (se confirma al entregar un pedido).', 'info'],
            'no-customer': ['No se encontró al cliente de esta reseña.', 'error'],
            already: ['Esta reseña ya estaba recompensada.', 'info']
        };
        toast(...messages[outcome]);
    } catch (error) {
        console.error('Error al recompensar reseña:', error);
        toast('No se pudo recompensar la reseña.', 'error');
    }
}

async function deleteReview(reviewId) {
    if (!confirm('¿Eliminar esta reseña? El cliente podrá volver a valorar ese pedido (y ganaría otra ñapa).')) return;
    try {
        const batch = writeBatch(db);
        batch.delete(doc(db, 'reviews', reviewId));
        batch.delete(doc(db, 'reviewAuthors', reviewId));
        await batch.commit();
        toast('Reseña eliminada.');
    } catch (error) {
        console.error('Error al eliminar reseña:', error);
        toast('No se pudo eliminar la reseña.', 'error');
    }
}

// ---------- Teléfonos vinculados (antifraude) ----------

$('releasePhoneBtn').addEventListener('click', async event => {
    const releaseMessage = $('releaseMessage');
    const phone = normalizePhone($('releasePhone').value);
    if (!phone) {
        showMessage(releaseMessage, 'Introduce un teléfono válido.', 'error');
        return;
    }
    if (!confirm(`¿Liberar el teléfono ${phone}? La cuenta que lo tiene vinculado tendrá que vincular otro antes de volver a pedir.`)) return;

    try {
        const result = await withBusy(event.currentTarget, 'Liberando…', () => runTransaction(db, async tx => {
            const claimRef = doc(db, 'phoneClaims', phone);
            const claimSnap = await tx.get(claimRef);
            if (!claimSnap.exists()) return null;
            const customerRef = doc(db, 'customers', claimSnap.data().uid);
            const customerSnap = await tx.get(customerRef);
            if (customerSnap.exists() && customerSnap.data().phone === phone) {
                tx.update(customerRef, { phone: null, phoneVerified: false, updatedAt: serverTimestamp() });
            }
            tx.delete(claimRef);
            return customerSnap.exists() ? customerSnap.data().name : 'cuenta eliminada';
        }));
        showMessage(releaseMessage, result
            ? `Teléfono liberado (estaba vinculado a «${result}»).`
            : 'Ese teléfono no está vinculado a ninguna cuenta.', result ? 'success' : 'info');
        if (result) $('releasePhone').value = '';
    } catch (error) {
        console.error('Error al liberar el teléfono:', error);
        showMessage(releaseMessage, 'No se pudo liberar el teléfono.', 'error');
    }
});

// ---------- Datos de prueba ----------

const seedMessage = $('seedMessage');

$('testAccounts').replaceChildren(...TEST_CUSTOMERS.map(customer =>
    el('li', {}, el('strong', { text: customer.name }), ` · ${customer.phone} · ${customer.referralCode}`)
));
$('testPhones').textContent = TEST_PHONES_LABEL;
$('testTarget').textContent = USE_EMULATORS ? 'los emuladores locales' : 'la base de datos REAL (producción)';

function confirmTarget(action) {
    return USE_EMULATORS || confirm(`Vas a ${action} en la base de datos REAL de producción. Solo afecta a datos marcados como prueba. ¿Continuar?`);
}

function seedErrorMessage(error) {
    return error?.code === 'permission-denied'
        ? 'Firestore rechazó la operación. ¿Has desplegado la última versión de firestore.rules?'
        : 'No se pudo completar la operación con los datos de prueba.';
}

$('seedBtn').addEventListener('click', async event => {
    if (!confirmTarget('generar datos de prueba')) return;
    try {
        const result = await withBusy(event.currentTarget, 'Generando…',
            () => seedTestData(db, step => showMessage(seedMessage, `${step}…`)));
        showMessage(seedMessage, `Datos de prueba listos: ${result.customers} clientes, ${result.orders} pedidos y ${result.reviews} reseñas.`, 'success');
    } catch (error) {
        console.error('Error generando datos de prueba:', error);
        showMessage(seedMessage, seedErrorMessage(error), 'error');
    }
});

$('clearSeedBtn').addEventListener('click', async event => {
    if (!confirmTarget('borrar los datos de prueba')) return;
    try {
        const result = await withBusy(event.currentTarget, 'Borrando…', () => clearTestData(db));
        showMessage(seedMessage, `Borrados ${result.customers} clientes, ${result.orders} pedidos y ${result.reviews} reseñas de prueba.`, 'success');
    } catch (error) {
        console.error('Error borrando datos de prueba:', error);
        showMessage(seedMessage, seedErrorMessage(error), 'error');
    }
});
