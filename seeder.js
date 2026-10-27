// Generador de datos de prueba para el panel del obrador.
// Los clientes son cuentas ficticias "seed_*" con teléfono de prueba vinculado y código de invitación.
// Los pedidos se crean con buildOrder() y se entregan con completeOrder(): se ejercita la lógica real
// de verificación del teléfono, referidos, ñapas y compras (que habilitan las reseñas).
import {
    addDoc, collection, doc, getDocs, query, serverTimestamp, updateDoc, where, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { TEST_CUSTOMERS } from "./env.js";
import { buildOrder, completeOrder } from "./orders.js";

const [ana, bruno, carla, diego, elena, fran, probador] = TEST_CUSTOMERS;

// Quién se dio de alta con el código de quién
const INVITED_BY = { [bruno.uid]: ana.referralCode, [carla.uid]: bruno.referralCode, [elena.uid]: fran.referralCode };

// Orden importante: Ana debe estar entregada antes que Bruno para que su invitación cuente
export const SCENARIO = [
    { customer: ana, items: { clasico: 4, bocadillo: 3 }, deliveryMethod: 'domicilio', address: 'Calle Mayor 12, 2º 1ª, Premià de Mar', slot: '10:00', status: 'completed' },
    { customer: bruno, items: { clasico: 6, bocadillo: 0 }, deliveryMethod: 'recogida', slot: '11:30', status: 'completed' },
    { customer: ana, items: { clasico: 2, bocadillo: 2 }, deliveryMethod: 'recogida', slot: '09:30', status: 'pending' },
    { customer: carla, items: { clasico: 0, bocadillo: 5 }, deliveryMethod: 'domicilio', address: 'Rambla de Mar 7, Premià de Mar', slot: '12:00', status: 'preparing' },
    { customer: diego, items: { clasico: 8, bocadillo: 0 }, deliveryMethod: 'recogida', slot: '08:00', status: 'ready' },
    { customer: elena, items: { clasico: 2, bocadillo: 1 }, deliveryMethod: 'recogida', slot: '13:30', status: 'pending' },
    { customer: fran, items: { clasico: 1, bocadillo: 0 }, deliveryMethod: 'recogida', slot: '17:00', status: 'rejected' },
    { customer: probador, items: { clasico: 3, bocadillo: 3 }, deliveryMethod: 'recogida', slot: '10:30', status: 'completed' }
];

// Reseñas de Ana (compró ambos productos). Su id sigue el esquema real "<uid>_<producto>".
export const SEED_REVIEWS = [
    { author: ana, product: 'clasico', ratings: { producto: 5, entrega: 5, atencion: 5 }, comment: 'Recién hechos y muy esponjosos. Repetiremos el domingo.' },
    { author: ana, product: 'bocadillo', ratings: { producto: 4, entrega: 5, atencion: 4 }, comment: 'El de guayaba buenísimo; quizá le pondría un poco más de relleno.' }
];

// Datos de prueba de la versión anterior (identificados por teléfono, sin campo "test")
const LEGACY_TEST_PHONES = ['+34600000000', '+34600000001', '+34600000002', '+34600000003',
    '+34600000004', '+34600000005', '+34600000006', '+34600023456'];

async function commitInChunks(db, allRefs) {
    // Un mismo documento puede salir en varias consultas (p. ej. reseñas antiguas de prueba)
    const refs = [...new Map(allRefs.map(ref => [ref.path, ref])).values()];
    for (let i = 0; i < refs.length; i += 400) {
        const batch = writeBatch(db);
        refs.slice(i, i + 400).forEach(ref => batch.delete(ref));
        await batch.commit();
    }
}

// Borra todo lo marcado como prueba (generador y cuentas anónimas del modo pruebas). Nunca toca datos reales.
export async function clearTestData(db) {
    const [customers, orders, reviews, legacyOrders, legacyAuthors] = await Promise.all([
        getDocs(query(collection(db, 'customers'), where('test', '==', true))),
        getDocs(query(collection(db, 'orders'), where('test', '==', true))),
        getDocs(query(collection(db, 'reviews'), where('test', '==', true))),
        getDocs(query(collection(db, 'orders'), where('phone', 'in', LEGACY_TEST_PHONES))),
        getDocs(query(collection(db, 'reviewAuthors'), where('phone', 'in', LEGACY_TEST_PHONES)))
    ]);

    const refs = [];
    customers.forEach(snap => {
        const { phone, referralCode } = snap.data();
        refs.push(snap.ref);
        if (phone) refs.push(doc(db, 'phoneClaims', phone));
        if (referralCode) refs.push(doc(db, 'referralCodes', referralCode));
    });
    orders.forEach(snap => refs.push(snap.ref));
    reviews.forEach(snap => refs.push(snap.ref, doc(db, 'reviewAuthors', snap.id)));
    legacyOrders.forEach(snap => refs.push(snap.ref));
    legacyAuthors.forEach(snap => refs.push(snap.ref, doc(db, 'reviews', snap.id)));
    LEGACY_TEST_PHONES.forEach(phone => refs.push(doc(db, 'customers', phone)));

    await commitInChunks(db, refs);
    const unique = (...snaps) => new Set(snaps.flatMap(s => s.docs.map(d => d.id))).size;
    return { customers: customers.size, orders: unique(orders, legacyOrders), reviews: unique(reviews, legacyAuthors) };
}

export async function seedTestData(db, onProgress = () => {}) {
    onProgress('Borrando datos de prueba anteriores');
    await clearTestData(db);

    onProgress('Creando clientes de prueba');
    const batch = writeBatch(db);
    for (const customer of TEST_CUSTOMERS) {
        batch.set(doc(db, 'customers', customer.uid), {
            name: customer.name,
            email: '',
            phone: customer.phone,
            address: '',
            referralCode: customer.referralCode,
            ...(INVITED_BY[customer.uid] ? { referredByCode: INVITED_BY[customer.uid] } : {}),
            test: true,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        batch.set(doc(db, 'phoneClaims', customer.phone), { uid: customer.uid, createdAt: serverTimestamp() });
        batch.set(doc(db, 'referralCodes', customer.referralCode), { uid: customer.uid });
    }
    await batch.commit();

    for (const [index, step] of SCENARIO.entries()) {
        onProgress(`Pedido ${index + 1}/${SCENARIO.length}: ${step.customer.name}`);
        const ref = await addDoc(collection(db, 'orders'), buildOrder({
            uid: step.customer.uid,
            name: step.customer.name,
            phone: step.customer.phone,
            items: step.items,
            deliveryMethod: step.deliveryMethod,
            address: step.address,
            slot: step.slot,
            test: true
        }));
        if (step.status === 'completed') await completeOrder(db, ref.id);
        else if (step.status !== 'pending') await updateDoc(ref, { status: step.status });
    }

    onProgress('Reseñas de prueba');
    const reviewsBatch = writeBatch(db);
    for (const review of SEED_REVIEWS) {
        const id = `${review.author.uid}_${review.product}`;
        reviewsBatch.set(doc(db, 'reviews', id), {
            product: review.product,
            ratings: review.ratings,
            comment: review.comment,
            test: true,
            rewarded: false,
            createdAt: serverTimestamp()
        });
        reviewsBatch.set(doc(db, 'reviewAuthors', id), { uid: review.author.uid, product: review.product });
    }
    await reviewsBatch.commit();

    return { customers: TEST_CUSTOMERS.length, orders: SCENARIO.length, reviews: SEED_REVIEWS.length };
}
