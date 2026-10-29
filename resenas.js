import {
    collection, doc, getDoc, getDocs, increment, limit, orderBy, query, serverTimestamp, where, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { mountEnvBanner, TEST_MODE } from "./env.js";
import { mountFaq } from "./faq.js";
import { db } from "./firebase.js";
import { hydrateIcons } from "./icons.js";
import { registerServiceWorker } from "./pwa.js";
import { playReward } from "./sound.js";
import { requireCustomer } from "./session.js";
import { el, formatDate, PRODUCT_NAMES, RATING_ASPECTS, showMessage, starsText, withBusy } from "./shared.js";
import { initUI, mountTopNav } from "./ui.js";

mountEnvBanner();
registerServiceWorker();
hydrateIcons();
mountFaq();
initUI();

const { session, profile } = await requireCustomer();
mountTopNav(profile);

const $ = id => document.getElementById(id);
const form = $('ratingForm');
const message = $('reviewMessage');

// Una reseña por pedido entregado: su id es el del pedido, y cada una da 1 ñapa (firestore.rules · isReviewReward).
// Las cuentas de prueba (anónimas) usan el mismo esquema; las reglas obligan a marcar sus reseñas como prueba.
let pendingOrders = []; // pedidos entregados de este cliente aún sin valorar

$('signedInAs').textContent = session.isTest
    ? '🧪 Valorando con una cuenta de prueba'
    : 'Tu reseña se publica sin tu nombre ni tus datos.';

// ---------- Reseñas públicas (anónimas) ----------

function scoreLabel(label, value) {
    return el('span', {},
        `${label} `,
        el('span', { className: 'stars-static', role: 'img', 'aria-label': `${value} de 5`, text: starsText(value) })
    );
}

function renderSummary(reviews) {
    const box = $('ratingSummary');
    if (!reviews.length) {
        box.replaceChildren(el('p', { className: 'empty-state', text: 'Todavía no hay valoraciones. ¡Sé el primero!' }));
        return;
    }
    box.replaceChildren(
        ...RATING_ASPECTS.map(([key, label]) => {
            const average = reviews.reduce((sum, review) => sum + (review.ratings?.[key] || 0), 0) / reviews.length;
            return el('div', { className: 'summary-row' },
                el('span', { text: label }),
                el('span', { className: 'stars-static', 'aria-hidden': 'true', text: starsText(average) }),
                el('strong', { text: average.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
            );
        }),
        el('p', { className: 'hint', text: `Media de las últimas ${reviews.length} ${reviews.length === 1 ? 'valoración' : 'valoraciones'} de clientes verificados.` })
    );
}

function renderList(reviews) {
    const list = $('reviewsList');
    if (!reviews.length) {
        list.replaceChildren();
        return;
    }
    list.replaceChildren(...reviews.map(review => el('article', { className: 'review-card' },
        el('div', { className: 'review-meta' },
            el('span', {},
                review.test
                    ? el('span', { className: 'test-tag', text: '🧪 Reseña de prueba' })
                    : el('span', { className: 'verified', text: '✔ Cliente verificado' }),
                ` · ${PRODUCT_NAMES[review.product] || ''}`),
            el('span', { text: formatDate(review.createdAt) })
        ),
        el('div', { className: 'review-scores' },
            RATING_ASPECTS.map(([key, label]) => scoreLabel(label, review.ratings?.[key]))
        ),
        review.comment ? el('p', { className: 'review-comment', text: review.comment }) : null
    )));
}

async function loadReviews() {
    try {
        const snap = await getDocs(query(collection(db, 'reviews'), orderBy('createdAt', 'desc'), limit(50)));
        // Las reseñas de cuentas de prueba solo se ven en modo pruebas y nunca cuentan para el público
        const reviews = snap.docs.map(d => d.data()).filter(review => TEST_MODE || !review.test);
        renderSummary(reviews);
        renderList(reviews);
    } catch (error) {
        console.error('Error al cargar reseñas:', error);
        $('ratingSummary').replaceChildren(el('p', { className: 'empty-state', text: 'No se pudieron cargar las valoraciones.' }));
    }
}

// ---------- Formulario de valoración ----------

function buildRatingFieldset([key, label]) {
    const stars = el('div', { className: 'rating-stars' });
    // Orden 5→1 en el DOM; CSS lo muestra al revés para poder rellenar con "~"
    for (let value = 5; value >= 1; value--) {
        const id = `rate-${key}-${value}`;
        stars.append(
            el('input', { type: 'radio', name: key, value, id }),
            el('label', { for: id, title: `${value} de 5`, 'aria-label': `${value} ${value === 1 ? 'estrella' : 'estrellas'}` }, '★')
        );
    }
    return el('fieldset', { className: 'rating' }, el('legend', { text: label }), stars);
}

$('ratingFields').replaceChildren(...RATING_ASPECTS.map(buildRatingFieldset));

function orderLabel(order) {
    const date = (order.completedAt ?? order.createdAt)?.toDate?.()
        .toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    const items = Object.keys(PRODUCT_NAMES)
        .filter(product => order.items?.[product] > 0)
        .map(product => `${order.items[product]} ${product === 'clasico' ? 'clásico' : 'con bocadillo'}${order.items[product] > 1 && product === 'clasico' ? 's' : ''}`);
    return { title: date ? `Entregado el ${date}` : 'Pedido entregado', detail: items.join(' · ') };
}

// Solo se pueden elegir los sabores que llevaba el pedido seleccionado
function syncProducts() {
    const order = pendingOrders.find(o => o.id === new FormData(form).get('order'));
    form.querySelectorAll('input[name="product"]').forEach(input => {
        const inOrder = Boolean(order?.items?.[input.value] > 0);
        input.disabled = !inOrder;
        if (!inOrder) input.checked = false;
        input.closest('label').querySelector('.choice-note').textContent = order && !inOrder ? 'No iba en este pedido' : '';
    });
    const available = [...form.querySelectorAll('input[name="product"]:not(:disabled)')];
    if (available.length === 1) available[0].checked = true;
}

// Pedidos entregados del cliente que aún no tienen reseña
async function loadPendingOrders() {
    const box = $('orderChoices');
    const legend = box.querySelector('legend');
    try {
        const snap = await getDocs(query(collection(db, 'orders'), where('uid', '==', session.uid)));
        const completed = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(order => order.status === 'completed')
            .sort((a, b) => (b.completedAt?.toMillis?.() ?? 0) - (a.completedAt?.toMillis?.() ?? 0));
        const reviewed = await Promise.all(completed.map(order => getDoc(doc(db, 'reviews', order.id)).then(r => r.exists(), () => false)));
        pendingOrders = completed.filter((_, i) => !reviewed[i]);

        if (!pendingOrders.length) {
            box.replaceChildren(legend, el('p', {
                className: 'hint',
                text: completed.length
                    ? 'Ya has valorado todos tus pedidos entregados. ¡Gracias! Con el próximo podrás ganar otra ñapa.'
                    : 'Cuando te entreguemos tu primer pedido podrás valorarlo aquí y ganar una ñapa.'
            }));
        } else {
            box.replaceChildren(legend, ...pendingOrders.map((order, i) => {
                const { title, detail } = orderLabel(order);
                return el('label', { className: 'choice-card' },
                    el('input', { type: 'radio', name: 'order', value: order.id, checked: i === 0 }),
                    el('span', { text: title }),
                    el('small', { className: 'choice-note', text: detail })
                );
            }));
        }
    } catch (error) {
        console.error('Error al cargar tus pedidos:', error);
        pendingOrders = [];
        box.replaceChildren(legend, el('p', { className: 'hint', text: 'No pudimos cargar tus pedidos. Recarga la página.' }));
    }
    $('submitReviewBtn').hidden = pendingOrders.length === 0;
    syncProducts();
}

form.addEventListener('change', event => {
    if (event.target.name === 'order') syncProducts();
});

form.addEventListener('submit', async event => {
    event.preventDefault();

    const data = new FormData(form);
    const orderId = data.get('order');
    const product = data.get('product');
    const ratings = Object.fromEntries(RATING_ASPECTS.map(([key]) => [key, Number(data.get(key))]));
    const comment = String(data.get('comment') || '').trim().slice(0, 500);

    if (!orderId) return showMessage(message, 'Elige qué pedido quieres valorar.', 'error');
    if (!product) return showMessage(message, 'Elige qué pandebono quieres valorar.', 'error');
    if (Object.values(ratings).some(value => !(value >= 1 && value <= 5))) {
        return showMessage(message, 'Puntúa producto, entrega y atención (de 1 a 5 estrellas).', 'error');
    }

    // La reseña pública no lleva datos personales; el vínculo con el cliente va aparte y es privado.
    // Recompensa: 1 ñapa por pedido entregado valorado, en el mismo lote que la reseña. La reseña usa el id
    // del pedido y solo se crea una vez, así que firestore.rules (isReviewReward) no deja repetir la ñapa.
    const batch = writeBatch(db);
    batch.set(doc(db, 'reviews', orderId), {
        product, ratings, comment,
        test: session.isTest,
        rewarded: true,
        createdAt: serverTimestamp()
    });
    batch.set(doc(db, 'reviewAuthors', orderId), { uid: session.uid, product });
    batch.update(doc(db, 'customers', session.uid), {
        napaCredits: increment(1),
        lastReviewedOrder: orderId,
        updatedAt: serverTimestamp()
    });

    try {
        await withBusy($('submitReviewBtn'), 'Publicando…', () => batch.commit());
        form.reset();
        await loadPendingOrders();
        profile.napaCredits = (profile.napaCredits || 0) + 1;
        mountTopNav(profile);
        playReward();
        const thanks = '¡Gracias por tu opinión! Has ganado 1 ñapa de regalo por este pedido: te la guardamos para el próximo.';
        showMessage(message, session.isTest ? `🧪 Reseña de prueba publicada. ${thanks}` : thanks, 'success');
        loadReviews();
    } catch (error) {
        console.error('Error al publicar la reseña:', error);
        const hint = session.isTest ? ' Una cuenta de prueba solo puede valorar tras una entrega (márcala como Entregado en el panel).' : '';
        showMessage(message, error.code === 'permission-denied'
            ? `No podemos publicarla: solo se puede valorar un pedido propio ya entregado, una sola vez y con un sabor que llevara.${hint}`
            : 'No se pudo publicar la valoración. Inténtalo de nuevo.', 'error');
    }
});

loadPendingOrders();
loadReviews();
