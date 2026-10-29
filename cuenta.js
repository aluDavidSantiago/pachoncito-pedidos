// Área del cliente recurrente: saldo de ñapas, historial de pedidos, código de invitación e instalación de la app.
import { collection, doc, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { mountEnvBanner } from "./env.js";
import { mountFaq } from "./faq.js";
import { db } from "./firebase.js";
import { hydrateIcons } from "./icons.js";
import { normalizeOrder } from "./orders.js";
import { mountInstallPrompt, registerServiceWorker } from "./pwa.js";
import { endSession, requireCustomer } from "./session.js";
import { el, formatDate, formatEUR, PRODUCT_NAMES, showMessage } from "./shared.js";
import { initUI, mountTopNav, toast } from "./ui.js";

mountEnvBanner();
registerServiceWorker();
hydrateIcons();
mountFaq();
initUI();

const { session, profile } = await requireCustomer();
mountTopNav(profile);
const $ = id => document.getElementById(id);

const STATUS = {
    pending: ['Pendiente', 'status-pending'],
    preparing: ['En preparación', 'status-preparing'],
    ready: ['Listo', 'status-ready'],
    completed: ['Entregado', 'status-completed'],
    rejected: ['Rechazado', 'status-rejected']
};

$('helloTitle').textContent = `Hola, ${profile.name.split(' ')[0]}`;
$('accountPhone').textContent = [
    session.isTest ? '🧪 Cuenta de prueba' : profile.email,
    `Teléfono ${profile.phone}${profile.phoneVerified ? ' (confirmado)' : ' (se confirma en tu primera entrega)'}`
].filter(Boolean).join(' · ');
// Saldo y contadores: se repintan solos cuando el obrador entrega un pedido o suma ñapas
function renderStats(data) {
    $('statNapas').textContent = data.napaCredits || 0;
    $('statOrders').textContent = data.completedOrders || 0;
    $('statReferrals').textContent = data.referralsCount || 0;
}
renderStats(profile);
$('referralCode').textContent = profile.referralCode || '—';

mountInstallPrompt($('installSlot'));

// ---------- Enlace de invitación ----------

const referralLink = new URL(`index.html?ref=${encodeURIComponent(profile.referralCode || '')}`, location.href).href;

$('shareBtn').addEventListener('click', async () => {
    const shareData = {
        title: 'Pachoncito',
        text: `Prueba los pandebonos de Pachoncito. Date de alta con mi código ${profile.referralCode}:`,
        url: referralLink
    };
    try {
        if (navigator.share) {
            await navigator.share(shareData);
        } else {
            await navigator.clipboard.writeText(`${shareData.text} ${referralLink}`);
            showMessage($('shareMessage'), 'Enlace copiado. Pégalo en WhatsApp o donde quieras.', 'success');
        }
    } catch (error) {
        if (error?.name === 'AbortError') return; // el cliente cerró el menú de compartir
        showMessage($('shareMessage'), `Tu enlace: ${referralLink}`, 'info');
    }
});

// ---------- Historial ----------

function itemsText(items = {}) {
    return Object.entries(PRODUCT_NAMES)
        .filter(([key]) => items[key] > 0)
        .map(([key, name]) => `${items[key]} × ${name}`)
        .join(' · ');
}

function orderItem(order) {
    const [statusText, statusClass] = STATUS[order.status] || STATUS.pending;
    return el('article', { className: 'review-card' },
        el('div', { className: 'review-meta' },
            el('span', { text: formatDate(order.createdAt) }),
            el('span', { className: `badge-status ${statusClass}`, text: statusText })
        ),
        el('p', { className: 'order-line', text: itemsText(order.items) }),
        el('p', { className: 'order-meta' },
            `${order.deliveryMethod === 'domicilio' ? 'A domicilio' : 'Recogida'} · ${order.deliverySlot || '—'} · `,
            el('strong', { text: formatEUR(order.totalCents) })
        ),
        order.napaCount > 0
            ? el('p', { className: 'meta-success', text: `${order.napaCount} ${order.napaCount === 1 ? 'ñapa' : 'ñapas'} de regalo` })
            : null,
        redeemedText(order)
            ? el('p', { className: 'meta-success', text: redeemedText(order) })
            : null
    );
}

// Ñapas acumuladas que el cliente eligió canjear en ese pedido (o que se canjearon al entregarlo)
function redeemedText(order) {
    const n = order.status === 'completed' ? order.creditsRedeemed : order.creditsToRedeem;
    if (!(n > 0) || order.status === 'rejected') return null;
    const verb = order.status === 'completed' ? (n === 1 ? 'canjeada' : 'canjeadas') : (n === 1 ? 'reservada' : 'reservadas');
    return `${n} ${n === 1 ? 'ñapa acumulada' : 'ñapas acumuladas'} ${verb}`;
}

// Historial en tiempo real: cuando el obrador cambia el estado (Listo, Entregado…) se ve al instante, sin recargar
let lastStatus = new Map(); // id → estado, para resaltar el pedido que acaba de cambiar
// Pedido recién reservado (cuenta.html?pedido=<id>, desde la confirmación de la carta): se destaca y se lleva a la vista
const trackedId = new URLSearchParams(location.search).get('pedido');
let trackedShown = false;

function watchOrders() {
    const list = $('ordersList');
    // Sin orderBy en la consulta para no necesitar índice compuesto: se ordena aquí
    return onSnapshot(query(collection(db, 'orders'), where('uid', '==', session.uid)), snap => {
        const orders = snap.docs.map(normalizeOrder)
            .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        const changed = orders.filter(order => lastStatus.has(order.id) && lastStatus.get(order.id) !== order.status);
        lastStatus = new Map(orders.map(order => [order.id, order.status]));
        list.replaceChildren(...(orders.length
            ? orders.map(order => {
                const card = orderItem(order);
                card.dataset.orderId = order.id;
                if (changed.includes(order)) card.classList.add('is-updated');
                if (order.id === trackedId) card.classList.add('is-tracked');
                return card;
            })
            : [el('p', { className: 'empty-state', text: 'Todavía no has hecho ningún pedido.' })]));
        const tracked = trackedId && list.querySelector('.is-tracked');
        if (tracked && !trackedShown) {
            trackedShown = true; // solo se desplaza la primera vez
            const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
            tracked.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
        }
        if (changed.length) {
            const [statusText] = STATUS[changed[0].status] || STATUS.pending;
            toast(`Tu pedido ha cambiado: ${statusText}.`, 'success');
        }
    }, error => {
        console.error('Error al cargar el historial:', error);
        list.replaceChildren(el('p', { className: 'empty-state', text: 'No se pudo cargar tu historial.' }));
    });
}

function watchProfile() {
    return onSnapshot(doc(db, 'customers', session.uid), snap => {
        const data = snap.data();
        if (!data) return;
        renderStats(data);
        mountTopNav({ ...profile, ...data });
    }, error => console.error('Error al escuchar tu cuenta:', error));
}

$('logoutBtn').addEventListener('click', async () => {
    await endSession();
    location.replace('acceso.html');
});

watchOrders();
watchProfile();
