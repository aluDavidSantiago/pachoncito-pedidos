// Lógica de pedidos compartida por la web (script.js), el panel (admin.js) y el generador de pruebas (seeder.js).
// buildOrder() produce exactamente la forma que exige validNewOrder() en firestore.rules.
import { doc, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { DELIVERY_CENTS, NAPA_EVERY_CENTS, normalizePhone, PRICES_CENTS } from "./shared.js";

export const PICKUP_ADDRESS = 'Recogida en local';

export function priceOrder(items, deliveryMethod) {
    const subtotalCents = items.clasico * PRICES_CENTS.clasico + items.bocadillo * PRICES_CENTS.bocadillo;
    const deliveryCents = deliveryMethod === 'domicilio' ? DELIVERY_CENTS : 0;
    const totalCents = subtotalCents + deliveryCents;
    // Las ñapas se calculan cada 10 € del total (incluyendo el envío)
    return { subtotalCents, deliveryCents, totalCents, napaCount: Math.floor(totalCents / NAPA_EVERY_CENTS) };
}

// uid = cuenta del cliente; phone = su teléfono/WhatsApp vinculado (contacto para la entrega)
// creditsToRedeem = ñapas acumuladas que el cliente elige canjear en este pedido (0…saldo); las demás se le guardan
export function buildOrder({ uid, name, phone, items, deliveryMethod, address, slot, test, creditsToRedeem }) {
    return {
        uid,
        customerName: name,
        phone,
        items: { clasico: items.clasico, bocadillo: items.bocadillo },
        ...priceOrder(items, deliveryMethod),
        deliveryMethod,
        address: deliveryMethod === 'domicilio' ? address : PICKUP_ADDRESS,
        deliverySlot: slot,
        ...(Number.isInteger(creditsToRedeem) ? { creditsToRedeem } : {}),
        status: 'pending',
        test: Boolean(test),
        createdAt: serverTimestamp()
    };
}

export function normalizeOrder(snap) {
    const data = snap.data();
    return {
        ...data,
        id: snap.id,
        // Compatibilidad con pedidos antiguos (en euros y sin cuenta de cliente)
        totalCents: Number.isInteger(data.totalCents) ? data.totalCents : Math.round((data.total || 0) * 100),
        napaCount: data.napaCount ?? (data.hasNapa ? 1 : 0),
        // null = pedido anterior a la elección de ñapas: canjea todo el saldo, como antes
        creditsToRedeem: Number.isInteger(data.creditsToRedeem) ? data.creditsToRedeem : null,
        phoneKey: normalizePhone(data.phone),
        uid: data.uid || null
    };
}

// Al entregar un pedido (en una sola transacción):
//  · el obrador confirma el teléfono del cliente (phoneVerified) — es la verificación antifraude;
//  · se registra la compra (habilita sus reseñas) y se canjean las ñapas acumuladas que eligió (el resto se guarda);
//  · si es su primera compra y se dio de alta con un código de invitación, su recomendador gana 1 ñapa;
//  · si existía un expediente antiguo con su teléfono (antes de las cuentas de Google), se fusiona.
export function completeOrder(db, orderId) {
    return runTransaction(db, async tx => {
        const orderRef = doc(db, 'orders', orderId);
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists()) throw new Error('El pedido ya no existe.');
        const order = normalizeOrder(orderSnap);
        if (order.status === 'completed') return null;

        const orderUpdate = { status: 'completed', completedAt: serverTimestamp() };
        if (!order.uid) {
            tx.update(orderRef, orderUpdate);
            return { warning: 'Pedido antiguo sin cuenta de cliente: se marca como entregado sin registrar ñapas.' };
        }

        // ---- Lecturas (todas antes de cualquier escritura) ----
        const customerRef = doc(db, 'customers', order.uid);
        const customerSnap = await tx.get(customerRef);
        if (!customerSnap.exists()) {
            tx.update(orderRef, orderUpdate);
            return { warning: 'No se encontró la cuenta del cliente: se marca como entregado sin registrar ñapas.' };
        }
        const customer = customerSnap.data();
        const isFirstPurchase = !customer.completedOrders;

        // Expediente antiguo (customers/{teléfono}) de antes de las cuentas de Google
        let legacyRef = null;
        let legacy = null;
        if (customer.phone && !customer.legacyMerged) {
            legacyRef = doc(db, 'customers', customer.phone);
            const legacySnap = await tx.get(legacyRef);
            if (legacySnap.exists() && !legacySnap.data().migratedTo) legacy = legacySnap.data();
        }

        let referrerRef = null;
        let referrer = null;
        if (isFirstPurchase && !legacy?.completedOrders && customer.referredByCode && !customer.referralRewarded) {
            const codeSnap = await tx.get(doc(db, 'referralCodes', customer.referredByCode));
            const referrerUid = codeSnap.exists() ? codeSnap.data().uid : null;
            if (referrerUid && referrerUid !== order.uid) {
                referrerRef = doc(db, 'customers', referrerUid);
                const referrerSnap = await tx.get(referrerRef);
                const candidate = referrerSnap.exists() ? referrerSnap.data() : null;
                // Solo cuenta si el recomendador ya tiene alguna compra entregada y ambos son del mismo tipo (real/prueba)
                if (candidate?.completedOrders > 0 && Boolean(candidate.test) === Boolean(customer.test)) referrer = candidate;
            }
        }

        // ---- Escrituras ----
        const purchased = customer.purchased || {};
        const legacyPurchased = legacy?.purchased || {};
        const available = (customer.napaCredits || 0) + (legacy?.napaCredits || 0);
        const creditsRedeemed = Math.min(order.creditsToRedeem ?? available, available);
        const customerUpdate = {
            completedOrders: (customer.completedOrders || 0) + (legacy?.completedOrders || 0) + 1,
            totalSpentCents: (customer.totalSpentCents || 0) + (legacy?.totalSpentCents || 0) + order.totalCents,
            purchased: {
                clasico: (purchased.clasico || 0) + (legacyPurchased.clasico || 0) + (order.items?.clasico || 0),
                bocadillo: (purchased.bocadillo || 0) + (legacyPurchased.bocadillo || 0) + (order.items?.bocadillo || 0)
            },
            napaCredits: available - creditsRedeemed,
            phoneVerified: true,
            updatedAt: serverTimestamp()
        };
        if (legacy) {
            customerUpdate.legacyMerged = true;
            if (legacy.feedbackRewarded) customerUpdate.feedbackRewarded = true;
            tx.update(legacyRef, { migratedTo: order.uid, updatedAt: serverTimestamp() });
        }
        if (referrer) {
            customerUpdate.referralRewarded = true;
            tx.update(referrerRef, {
                napaCredits: (referrer.napaCredits || 0) + 1,
                referralsCount: (referrer.referralsCount || 0) + 1,
                updatedAt: serverTimestamp()
            });
            orderUpdate.referralRewarded = true;
        }
        tx.update(customerRef, customerUpdate);

        orderUpdate.creditsRedeemed = creditsRedeemed;
        tx.update(orderRef, orderUpdate);
        return { creditsRedeemed, referrerRewarded: Boolean(referrer), legacyMerged: Boolean(legacy) };
    });
}
