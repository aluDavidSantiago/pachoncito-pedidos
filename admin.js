import {
    collection, deleteDoc, doc, getDoc, limit, onSnapshot, orderBy, query,
    runTransaction, serverTimestamp, updateDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { auth } from "./auth.js";
import { isTestPhone, mountEnvBanner, TEST_CUSTOMERS, TEST_OTP, USE_EMULATORS } from "./env.js";
import { db } from "./firebase.js";
import { completeOrder, normalizeOrder } from "./orders.js";
import { clearTestData, seedTestData } from "./seeder.js";
import { el, formatDate, formatEUR, PRODUCT_NAMES, RATING_ASPECTS, showMessage, starsText, withBusy } from "./shared.js";

mountEnvBanner();
const $ = id => document.getElementById(id);
const adminMessage = $('adminMessage');

const STATUS = {
    pending: { text: 'Pendiente', action: 'Pendiente', className: 'status-pending' },
    preparing: { text: 'En preparación', action: 'Preparando', className: 'status-preparing' },
    ready: { text: 'Listo', action: 'Listo', className: 'status-ready' },
    completed: { text: 'Entregado', action: 'Entregado', className: 'status-completed' },
    rejected: { text: 'Rechazado', action: 'Rechazar', className: 'status-rejected' }
};

let orders = [];
let customers = new Map();
let reviews = [];
let production = { clasicos: 0, bocadillos: 0, napas: 0, ingresosCents: 0 };
let unsubscribers = [];

// ---------- Autenticación ----------

function showView(view) {
    $('authStatus').hidden = view !== 'loading';
    $('loginView').hidden = view !== 'login';
    $('dashboard').hidden = view !== 'dashboard';
    $('logoutBtn').hidden = view !== 'dashboard';
}

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
    const email = $('adminEmail').value.trim();
    const password = $('adminPassword').value;
    if (!email || !password) {
        showMessage($('loginMessage'), 'Introduce email y contraseña.', 'error');
        return;
    }
    try {
        await withBusy(event.submitter, 'Entrando…', () => signInWithEmailAndPassword(auth, email, password));
    } catch (error) {
        showMessage($('loginMessage'), loginErrorMessage(error), 'error');
    }
});

$('logoutBtn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async user => {
    stopListeners();
    if (!user) {
        showView('login');
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
        showView('login');
        if (user.email) showMessage($('loginMessage'), 'Esta cuenta no tiene permisos de administración.', 'error');
        return;
    }

    showMessage($('loginMessage'), '');
    $('loginForm').reset();
    showView('dashboard');
    startListeners();
});

// ---------- Datos en tiempo real ----------

function startListeners() {
    const onError = error => {
        console.error('Error de Firestore:', error);
        showMessage(adminMessage, 'Se perdió la conexión con la base de datos o faltan permisos.', 'error');
    };

    unsubscribers = [
        onSnapshot(query(collection(db, 'orders'), orderBy('createdAt', 'desc')), snap => {
            orders = snap.docs.map(normalizeOrder);
            renderOrdersAndStats();
        }, onError),
        onSnapshot(collection(db, 'customers'), snap => {
            customers = new Map(snap.docs.map(d => [d.id, d.data()]));
            renderOrdersAndStats();
        }, onError),
        onSnapshot(query(collection(db, 'reviews'), orderBy('createdAt', 'desc'), limit(100)), snap => {
            reviews = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            renderReviews();
        }, onError)
    ];
}

function stopListeners() {
    unsubscribers.forEach(unsubscribe => unsubscribe());
    unsubscribers = [];
    orders = [];
    customers = new Map();
    reviews = [];
}

// Ñapas acumuladas (referidos / feedback) que se entregan con este pedido
function accumulatedNapas(order) {
    if (order.status === 'completed') return order.creditsRedeemed || 0;
    return customers.get(order.phoneKey)?.napaCredits || 0;
}

function renderOrdersAndStats() {
    renderStats();
    renderOrders();
}

// ---------- Producción y finanzas ----------

function renderStats() {
    let clasicos = 0, bocadillos = 0, napas = 0, ingresosCents = 0;
    const phonesWithCredits = new Set();

    for (const order of orders) {
        if (order.status === 'rejected') continue;
        clasicos += order.items?.clasico || 0;
        bocadillos += order.items?.bocadillo || 0;
        napas += order.napaCount;
        ingresosCents += order.totalCents;

        if (order.status === 'completed') {
            napas += order.creditsRedeemed || 0;
        } else if (order.phoneKey && !phonesWithCredits.has(order.phoneKey)) {
            // Un cliente con varios pedidos abiertos solo canjea sus ñapas una vez
            phonesWithCredits.add(order.phoneKey);
            napas += customers.get(order.phoneKey)?.napaCredits || 0;
        }
    }

    $('totalClasicos').textContent = clasicos;
    $('totalBocadillo').textContent = bocadillos;
    $('totalNapas').textContent = napas;
    production = { clasicos, bocadillos, napas, ingresosCents };
    recalcularCostes();
}

function ingredientRow(name, amount, extraClass) {
    return el('div', { className: `ingredient-item ${extraClass || ''}` }, name, el('strong', { text: amount }));
}

function recalcularCostes() {
    const { clasicos, bocadillos, napas, ingresosCents } = production;
    // Las ñapas también se hornean, así que cuentan para la producción
    const totalPanes = clasicos + bocadillos + napas;
    const listaCompraBox = $('listaCompraBox');

    if (totalPanes === 0) {
        listaCompraBox.replaceChildren(el('div', { className: 'ingredient-item', text: 'Sin pedidos activos' }));
        $('totalInversion').textContent = formatEUR(0);
        $('totalBeneficio').textContent = formatEUR(0);
        return;
    }

    const tandas = Math.ceil(totalPanes / 16);
    listaCompraBox.replaceChildren(
[línea retirada: dato privado del obrador]
[línea retirada: dato privado del obrador]
[línea retirada: dato privado del obrador]
[línea retirada: dato privado del obrador]
        ingredientRow('Huevos L (Estuche 12u)', `${Math.ceil((tandas * 2) / 12)} estuche(s)`),
        ingredientRow('Pasta Guayaba (1kg)', `${bocadillos > 0 ? Math.ceil((bocadillos * 15) / 1000) : 0} bloque(s)`),
        ingredientRow('Tandas de producción (16u)', `${tandas} tanda(s)`, 'is-total')
    );

    const costeTanda = [...document.querySelectorAll('.cost-input')]
        .reduce((sum, input) => sum + (parseFloat(input.value) || 0), 0);
    const inversionCents = Math.round(tandas * costeTanda * 100);

    $('totalInversion').textContent = formatEUR(inversionCents);
    $('totalBeneficio').textContent = formatEUR(ingresosCents - inversionCents);
}

document.querySelectorAll('.cost-input').forEach(input => input.addEventListener('input', recalcularCostes));

// ---------- Pedidos ----------

function metaLine(...parts) {
    return el('p', {}, ...parts);
}

function orderCard(order) {
    const status = STATUS[order.status] || STATUS.pending;
    const isClosed = order.status === 'completed';
    const credits = accumulatedNapas(order);
    const phoneNode = order.phoneKey
        ? el('a', { className: 'order-phone', href: `tel:${order.phoneKey}`, text: `📞 ${order.phone}` })
        : el('span', { className: 'order-phone', text: `📞 ${order.phone || 'Sin teléfono'}` });

    const meta = el('div', { className: 'order-meta' },
        metaLine('🥖 ', el('strong', { text: 'Clásicos:' }), ` ${order.items?.clasico || 0} · 🫓 `,
            el('strong', { text: 'Bocadillo:' }), ` ${order.items?.bocadillo || 0}`),
        metaLine('📦 ', el('strong', { text: 'Entrega:' }), ' ',
            order.deliveryMethod === 'domicilio' ? `A domicilio — ${order.address}` : 'Recogida en local'),
        metaLine('⏰ ', el('strong', { text: 'Hora:' }), ` ${order.deliverySlot || '—'} · 💰 `,
            el('strong', { text: 'Total:' }), ` ${formatEUR(order.totalCents)}`),
        order.createdAt ? metaLine('📅 ', formatDate(order.createdAt)) : null,
        order.napaCount > 0
            ? el('p', { className: 'meta-success', text: `🎁 Incluye ${order.napaCount} ${order.napaCount === 1 ? 'ñapa' : 'ñapas'} por volumen de compra` })
            : null,
        credits > 0
            ? el('p', {
                className: 'meta-success',
                text: isClosed
                    ? `🎁 Se entregaron ${credits} ${credits === 1 ? 'ñapa acumulada' : 'ñapas acumuladas'} (referidos / reseñas)`
                    : `🎁 +${credits} ${credits === 1 ? 'ñapa acumulada' : 'ñapas acumuladas'} (referidos / reseñas): entrégalas en este pedido`
            })
            : null,
        order.referralCode
            ? el('p', { className: 'meta-accent', text: `🤝 Recomendado por ${order.referralCode}${order.referralRewarded ? ' — ñapa concedida al recomendador' : ''}` })
            : null,
        order.status === 'rejected'
            ? el('p', { className: 'meta-danger', text: '❌ Pedido rechazado por el obrador' })
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
        }, '🗑️ Borrar')
    );

    return el('article', { className: 'order-card' },
        el('div', { className: 'order-info' },
            el('h3', {}, order.customerName || 'Sin nombre', phoneNode,
                isTestPhone(order.phoneKey) ? el('span', { className: 'test-tag', text: '🧪 Prueba' }) : null),
            meta,
            actions
        ),
        el('span', { className: `badge-status ${status.className}`, text: status.text })
    );
}

function renderOrders() {
    const container = $('ordersContainer');
    if (!orders.length) {
        container.replaceChildren(el('p', { className: 'empty-state', text: 'No hay pedidos registrados todavía.' }));
        return;
    }
    container.replaceChildren(...orders.map(orderCard));
}

async function changeStatus(order, newStatus, button) {
    try {
        if (newStatus === 'completed') {
            if (!confirm('¿Marcar como entregado? Se registrará la compra del cliente, se canjearán sus ñapas acumuladas y, si vino recomendado, su recomendador ganará una ñapa. No se puede deshacer.')) return;
            const result = await withBusy(button, '…', () => completeOrder(db, order.id));
            if (result) {
                const notes = ['Pedido entregado y registrado.'];
                if (result.creditsRedeemed) notes.push(`Ñapas acumuladas canjeadas: ${result.creditsRedeemed}.`);
                if (result.referrerRewarded) notes.push('El recomendador ha ganado una ñapa para su próximo pedido.');
                if (result.warning) notes.push(result.warning);
                showMessage(adminMessage, notes.join(' '), result.warning ? 'info' : 'success');
            }
        } else {
            await updateDoc(doc(db, 'orders', order.id), { status: newStatus });
        }
    } catch (error) {
        console.error('Error al actualizar estado:', error);
        showMessage(adminMessage, 'No se pudo actualizar el pedido.', 'error');
    }
}

async function deleteOrder(orderId) {
    if (!confirm('¿Seguro que quieres eliminar este pedido permanentemente?')) return;
    try {
        await deleteDoc(doc(db, 'orders', orderId));
    } catch (error) {
        console.error('Error al eliminar pedido:', error);
        showMessage(adminMessage, 'No se pudo eliminar el pedido.', 'error');
    }
}

// ---------- Reseñas ----------

function reviewCard(review) {
    const scores = RATING_ASPECTS
        .map(([key, label]) => `${label} ${starsText(review.ratings?.[key])}`)
        .join(' · ');

    return el('article', { className: 'order-card' },
        el('div', { className: 'order-info' },
            el('h3', {}, PRODUCT_NAMES[review.product] || review.product,
                review.test ? el('span', { className: 'test-tag', text: '🧪 Prueba' }) : null),
            el('p', { className: 'order-meta stars-static', text: scores }),
            review.comment ? el('p', { className: 'review-comment', text: review.comment }) : null,
            el('p', { className: 'order-meta', text: formatDate(review.createdAt) }),
            review.rewarded ? el('p', { className: 'meta-success', text: '🎁 Reseña recompensada' }) : null,
            el('div', { className: 'actions-bar' },
                review.rewarded ? null : el('button', {
                    type: 'button',
                    className: 'btn btn-small',
                    onClick: event => rewardReview(review.id, event.currentTarget)
                }, '🎁 Dar ñapa por feedback'),
                el('button', {
                    type: 'button',
                    className: 'btn btn-small btn-danger',
                    onClick: () => deleteReview(review.id)
                }, '🗑️ Eliminar')
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

// Recompensa por feedback: 1 ñapa por cliente (la primera reseña premiada)
async function rewardReview(reviewId, button) {
    try {
        const outcome = await withBusy(button, '…', () => runTransaction(db, async tx => {
            const reviewRef = doc(db, 'reviews', reviewId);
            const reviewSnap = await tx.get(reviewRef);
            const authorSnap = await tx.get(doc(db, 'reviewAuthors', reviewId));
            if (!reviewSnap.exists() || reviewSnap.data().rewarded) return 'already';

            const customerRef = authorSnap.exists() ? doc(db, 'customers', authorSnap.data().phone) : null;
            const customerSnap = customerRef ? await tx.get(customerRef) : null;
            tx.update(reviewRef, { rewarded: true });

            if (!customerSnap?.exists()) return 'no-customer';
            const customer = customerSnap.data();
            if (customer.feedbackRewarded) return 'customer-already';

            tx.update(customerRef, {
                napaCredits: (customer.napaCredits || 0) + 1,
                feedbackRewarded: true,
                updatedAt: serverTimestamp()
            });
            return 'rewarded';
        }));

        const messages = {
            rewarded: ['Ñapa añadida: se entregará en el próximo pedido del cliente.', 'success'],
            'customer-already': ['Este cliente ya recibió su ñapa por feedback; la reseña queda marcada.', 'info'],
            'no-customer': ['No se encontró al cliente de esta reseña.', 'error'],
            already: ['Esta reseña ya estaba recompensada.', 'info']
        };
        showMessage(adminMessage, ...messages[outcome]);
    } catch (error) {
        console.error('Error al recompensar reseña:', error);
        showMessage(adminMessage, 'No se pudo recompensar la reseña.', 'error');
    }
}

async function deleteReview(reviewId) {
    if (!confirm('¿Eliminar esta reseña? El cliente podrá volver a valorar ese producto.')) return;
    try {
        const batch = writeBatch(db);
        batch.delete(doc(db, 'reviews', reviewId));
        batch.delete(doc(db, 'reviewAuthors', reviewId));
        await batch.commit();
    } catch (error) {
        console.error('Error al eliminar reseña:', error);
        showMessage(adminMessage, 'No se pudo eliminar la reseña.', 'error');
    }
}

// ---------- Datos de prueba ----------

const seedMessage = $('seedMessage');

$('testAccounts').replaceChildren(...TEST_CUSTOMERS.map(customer =>
    el('li', {}, el('strong', { text: customer.name }), ` · ${customer.phone}`)
));
$('testOtp').textContent = TEST_OTP;
$('testTarget').textContent = USE_EMULATORS ? 'los emuladores locales' : 'la base de datos REAL (producción)';

function confirmTarget(action) {
    return USE_EMULATORS || confirm(`Vas a ${action} en la base de datos REAL de producción. Solo afecta a los teléfonos de prueba (+34 600 000 000–006). ¿Continuar?`);
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
            () => seedTestData(db, step => showMessage(seedMessage, `🧪 ${step}…`)));
        showMessage(seedMessage, `🧪 Datos de prueba listos: ${result.orders} pedidos y ${result.reviews} reseñas.`, 'success');
    } catch (error) {
        console.error('Error generando datos de prueba:', error);
        showMessage(seedMessage, seedErrorMessage(error), 'error');
    }
});

$('clearSeedBtn').addEventListener('click', async event => {
    if (!confirmTarget('borrar los datos de prueba')) return;
    try {
        const result = await withBusy(event.currentTarget, 'Borrando…', () => clearTestData(db));
        showMessage(seedMessage, `🧹 Borrados ${result.orders} pedidos y ${result.reviews} reseñas de prueba, y sus clientes.`, 'success');
    } catch (error) {
        console.error('Error borrando datos de prueba:', error);
        showMessage(seedMessage, seedErrorMessage(error), 'error');
    }
});
