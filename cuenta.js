// Área del cliente recurrente: saldo de ñapas, historial de pedidos, código de invitación e instalación de la app.
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { mountEnvBanner } from "./env.js";
import { mountFaq } from "./faq.js";
import { db } from "./firebase.js";
import { hydrateIcons } from "./icons.js";
import { normalizeOrder } from "./orders.js";
import { mountInstallPrompt, registerServiceWorker } from "./pwa.js";
import { endSession, requireCustomer } from "./session.js";
import { el, formatDate, formatEUR, PRODUCT_NAMES, showMessage } from "./shared.js";
import { initUI } from "./ui.js";

mountEnvBanner();
registerServiceWorker();
hydrateIcons();
mountFaq();
initUI();

const { session, profile } = await requireCustomer();
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
$('statNapas').textContent = profile.napaCredits || 0;
$('statOrders').textContent = profile.completedOrders || 0;
$('statReferrals').textContent = profile.referralsCount || 0;
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
            : null
    );
}

async function loadOrders() {
    const list = $('ordersList');
    try {
        // Sin orderBy en la consulta para no necesitar índice compuesto: se ordena aquí
        const snap = await getDocs(query(collection(db, 'orders'), where('uid', '==', session.uid)));
        const orders = snap.docs.map(normalizeOrder)
            .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        list.replaceChildren(...(orders.length
            ? orders.map(orderItem)
            : [el('p', { className: 'empty-state', text: 'Todavía no has hecho ningún pedido.' })]));
    } catch (error) {
        console.error('Error al cargar el historial:', error);
        list.replaceChildren(el('p', { className: 'empty-state', text: 'No se pudo cargar tu historial.' }));
    }
}

$('logoutBtn').addEventListener('click', async () => {
    await endSession();
    location.replace('acceso.html');
});

loadOrders();
