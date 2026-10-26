// Generador de datos de prueba para el panel del obrador.
// No escribe datos "a mano": crea los pedidos con buildOrder() (pasan por las mismas reglas que un cliente)
// y los entrega con completeOrder(), así se ejercita la lógica real de clientes, referidos y ñapas.
import {
    addDoc, collection, doc, getDocs, query, serverTimestamp, updateDoc, where, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { TEST_CUSTOMERS, TEST_PHONES } from "./env.js";
import { buildOrder, completeOrder } from "./orders.js";

const [ana, bruno, carla, diego, elena, fran] = TEST_CUSTOMERS;

// Orden importante: Ana debe estar entregada antes que Bruno para que su referido cuente
export const SCENARIO = [
    { customer: ana, items: { clasico: 4, bocadillo: 3 }, deliveryMethod: 'domicilio', address: 'Calle Mayor 12, 2º 1ª, Premià de Mar', slot: '10:00', status: 'completed' },
    { customer: bruno, items: { clasico: 6, bocadillo: 0 }, deliveryMethod: 'recogida', slot: '11:30', referralCode: ana.phone, status: 'completed' },
    { customer: ana, items: { clasico: 2, bocadillo: 2 }, deliveryMethod: 'recogida', slot: '09:30', status: 'pending' },
    { customer: carla, items: { clasico: 0, bocadillo: 5 }, deliveryMethod: 'domicilio', address: 'Rambla de Mar 7, Premià de Mar', slot: '12:00', referralCode: bruno.phone, status: 'preparing' },
    { customer: diego, items: { clasico: 8, bocadillo: 0 }, deliveryMethod: 'recogida', slot: '08:00', status: 'ready' },
    { customer: elena, items: { clasico: 2, bocadillo: 1 }, deliveryMethod: 'recogida', slot: '13:30', referralCode: fran.phone, status: 'pending' },
    { customer: fran, items: { clasico: 1, bocadillo: 0 }, deliveryMethod: 'recogida', slot: '17:00', status: 'rejected' }
];

// Reseñas solo de Ana, que tiene compras de ambos productos.
// Bruno queda libre para probar el flujo real de reseñas (y que el bocadillo se rechace porque no lo compró).
export const SEED_REVIEWS = [
    { id: 'seed_ana_clasico', author: ana, product: 'clasico', ratings: { producto: 5, entrega: 5, atencion: 5 }, comment: '¡Recién hechos y súper esponjosos! Repetiremos el domingo.' },
    { id: 'seed_ana_bocadillo', author: ana, product: 'bocadillo', ratings: { producto: 4, entrega: 5, atencion: 4 }, comment: 'El de guayaba buenísimo, quizá le pondría un poco más de relleno.' }
];

export async function clearTestData(db) {
    const [orders, authors] = await Promise.all([
        getDocs(query(collection(db, 'orders'), where('phone', 'in', TEST_PHONES))),
        getDocs(query(collection(db, 'reviewAuthors'), where('phone', 'in', TEST_PHONES)))
    ]);

    const batch = writeBatch(db);
    orders.forEach(snap => batch.delete(snap.ref));
    authors.forEach(snap => {
        batch.delete(snap.ref);
        batch.delete(doc(db, 'reviews', snap.id));
    });
    TEST_PHONES.forEach(phone => batch.delete(doc(db, 'customers', phone)));
    await batch.commit();

    return { orders: orders.size, reviews: authors.size };
}

export async function seedTestData(db, onProgress = () => {}) {
    await clearTestData(db);

    for (const [index, step] of SCENARIO.entries()) {
        onProgress(`Pedido ${index + 1}/${SCENARIO.length}: ${step.customer.name}`);
        const ref = await addDoc(collection(db, 'orders'), buildOrder({
            name: step.customer.name,
            phone: step.customer.phone,
            items: step.items,
            deliveryMethod: step.deliveryMethod,
            address: step.address,
            slot: step.slot,
            referralCode: step.referralCode
        }));
        if (step.status === 'completed') await completeOrder(db, ref.id);
        else if (step.status !== 'pending') await updateDoc(ref, { status: step.status });
    }

    onProgress('Reseñas de prueba');
    const batch = writeBatch(db);
    for (const review of SEED_REVIEWS) {
        batch.set(doc(db, 'reviews', review.id), {
            product: review.product,
            ratings: review.ratings,
            comment: review.comment,
            test: true,
            rewarded: false,
            createdAt: serverTimestamp()
        });
        batch.set(doc(db, 'reviewAuthors', review.id), { uid: 'seed', phone: review.author.phone, product: review.product });
    }
    await batch.commit();

    return { orders: SCENARIO.length, reviews: SEED_REVIEWS.length };
}
