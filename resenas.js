import {
    collection, doc, getDoc, getDocs, limit, orderBy, query, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { auth } from "./auth.js";
import { isTestPhone, mountEnvBanner, TEST_MODE } from "./env.js";
import { db } from "./firebase.js";
import { createPhoneLogin, phoneAuthErrorMessage } from "./phone-auth.js";
import { el, formatDate, normalizePhone, PRODUCT_NAMES, RATING_ASPECTS, showMessage, starsText, storage, withBusy } from "./shared.js";

mountEnvBanner();
const phoneLogin = createPhoneLogin(auth, 'recaptcha-container');

const $ = id => document.getElementById(id);
const form = $('ratingForm');
const message = $('reviewMessage');
let currentUser = null;

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

function showStep(step) {
    $('stepPhone').hidden = step !== 'phone';
    $('stepCode').hidden = step !== 'code';
    form.hidden = step !== 'form';
}

// Desactiva los productos que este cliente ya ha valorado (1 reseña por producto)
async function markReviewedProducts() {
    let pending = 0;
    for (const product of Object.keys(PRODUCT_NAMES)) {
        const input = form.querySelector(`input[name="product"][value="${product}"]`);
        let done = false;
        try {
            done = (await getDoc(doc(db, 'reviews', `${currentUser.uid}_${product}`))).exists();
        } catch (error) {
            console.error('Error comprobando reseñas previas:', error);
        }
        input.disabled = done;
        if (done) input.checked = false;
        input.closest('label').querySelector('.choice-note').textContent = done ? 'Ya valorado ✔' : '';
        if (!done) pending++;
    }
    $('submitReviewBtn').hidden = pending === 0;
    if (pending === 0) showMessage(message, 'Ya has valorado todos nuestros productos. ¡Gracias por tu opinión! 🥖', 'success');
}

$('reviewPhone').value = storage.get('pachoncito_user')?.phone || '';

$('sendCodeBtn').addEventListener('click', async event => {
    const phone = normalizePhone($('reviewPhone').value);
    if (!phone) {
        showMessage(message, 'Introduce un teléfono válido (9 cifras o formato +34…).', 'error');
        return;
    }
    try {
        const { suggestedCode } = await withBusy(event.currentTarget, 'Enviando SMS…', () => phoneLogin.send(phone));
        showStep('code');
        $('reviewCode').value = suggestedCode || '';
        showMessage(message, suggestedCode
            ? '🧪 Número de prueba: no se envía SMS y el código ya está rellenado.'
            : 'Te hemos enviado un SMS con el código.', 'success');
        $(suggestedCode ? 'verifyCodeBtn' : 'reviewCode').focus();
    } catch (error) {
        console.error('Error al enviar el SMS:', error);
        showMessage(message, phoneAuthErrorMessage(error), 'error');
    }
});

$('verifyCodeBtn').addEventListener('click', async event => {
    const code = $('reviewCode').value.trim();
    if (!/^\d{6}$/.test(code)) {
        showMessage(message, 'El código tiene 6 dígitos.', 'error');
        return;
    }
    try {
        await withBusy(event.currentTarget, 'Verificando…', () => phoneLogin.confirm(code));
        showMessage(message, '');
    } catch (error) {
        showMessage(message, phoneAuthErrorMessage(error), 'error');
    }
});

$('changePhoneBtn').addEventListener('click', () => {
    showMessage(message, '');
    showStep('phone');
});

$('signOutBtn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async user => {
    // Solo sirven cuentas verificadas por SMS (no las del obrador)
    currentUser = user?.phoneNumber ? user : null;
    if (!currentUser) {
        showStep('phone');
        return;
    }
    $('signedInAs').textContent = `Verificado: ${currentUser.phoneNumber}`;
    showStep('form');
    await markReviewedProducts();
});

form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!currentUser) return showStep('phone');

    const data = new FormData(form);
    const product = data.get('product');
    const ratings = Object.fromEntries(RATING_ASPECTS.map(([key]) => [key, Number(data.get(key))]));
    const comment = String(data.get('comment') || '').trim().slice(0, 500);

    if (!product) return showMessage(message, 'Elige qué pandebono quieres valorar.', 'error');
    if (Object.values(ratings).some(value => !(value >= 1 && value <= 5))) {
        return showMessage(message, 'Puntúa producto, entrega y atención (de 1 a 5 estrellas).', 'error');
    }

    // La reseña pública no lleva datos personales; el vínculo con el teléfono va aparte y es privado
    const reviewId = `${currentUser.uid}_${product}`;
    const batch = writeBatch(db);
    batch.set(doc(db, 'reviews', reviewId), {
        product, ratings, comment,
        test: isTestPhone(currentUser.phoneNumber), // las reglas comprueban que coincide con el teléfono verificado
        rewarded: false,
        createdAt: serverTimestamp()
    });
    batch.set(doc(db, 'reviewAuthors', reviewId), { uid: currentUser.uid, phone: currentUser.phoneNumber, product });

    try {
        await withBusy($('submitReviewBtn'), 'Publicando…', () => batch.commit());
        form.reset();
        await markReviewedProducts();
        showMessage(message, '¡Gracias por tu valoración! 🎁 Revisaremos tu reseña y te guardaremos una ñapa para tu próximo pedido.', 'success');
        loadReviews();
    } catch (error) {
        console.error('Error al publicar la reseña:', error);
        showMessage(message, error.code === 'permission-denied'
            ? 'No podemos publicarla: solo pueden valorar clientes con un pedido entregado de ese producto, y una sola vez por producto.'
            : 'No se pudo publicar la valoración. Inténtalo de nuevo.', 'error');
    }
});

loadReviews();
