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

export function buildOrder({ name, phone, items, deliveryMethod, address, slot, referralCode }) {
    const order = {
        customerName: name,
        phone,
        items: { clasico: items.clasico, bocadillo: items.bocadillo },
        ...priceOrder(items, deliveryMethod),
        deliveryMethod,
        address: deliveryMethod === 'domicilio' ? address : PICKUP_ADDRESS,
        deliverySlot: slot,
        status: 'pending',
        createdAt: serverTimestamp()
    };
    if (referralCode) order.referralCode = referralCode;
    return order;
}

export function normalizeOrder(snap) {
    const data = snap.data();
    return {
        ...data,
        id: snap.id,
        // Compatibilidad con pedidos antiguos guardados en euros
        totalCents: Number.isInteger(data.totalCents) ? data.totalCents : Math.round((data.total || 0) * 100),
        napaCount: data.napaCount ?? (data.hasNapa ? 1 : 0),
        phoneKey: normalizePhone(data.phone)
    };
}

// Al entregar un pedido: se registra al cliente, se canjean sus ñapas acumuladas
// y, si es su primera compra y trae código de referido válido, el recomendador gana 1 ñapa.
export function completeOrder(db, orderId) {
    return runTransaction(db, async tx => {
        const orderRef = doc(db, 'orders', orderId);
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists()) throw new Error('El pedido ya no existe.');
        const order = normalizeOrder(orderSnap);
        if (order.status === 'completed') return null;

        const orderUpdate = { status: 'completed', completedAt: serverTimestamp() };
        if (!order.phoneKey) {
            tx.update(orderRef, orderUpdate);
            return { warning: 'El teléfono no es válido: no se pudo registrar al cliente.' };
        }

        const customerRef = doc(db, 'customers', order.phoneKey);
        const customerSnap = await tx.get(customerRef);
        const customer = customerSnap.exists() ? customerSnap.data() : null;
        const isFirstPurchase = !customer?.completedOrders;

        let referrerRef = null;
        let referrer = null;
        const referrerPhone = normalizePhone(order.referralCode);
        if (isFirstPurchase && referrerPhone && referrerPhone !== order.phoneKey && !order.referralRewarded) {
            referrerRef = doc(db, 'customers', referrerPhone);
            const referrerSnap = await tx.get(referrerRef);
            // Solo cuenta si el recomendador ya es cliente con alguna compra entregada
            if (referrerSnap.exists() && referrerSnap.data().completedOrders > 0) referrer = referrerSnap.data();
        }

        const purchased = customer?.purchased || {};
        const creditsRedeemed = customer?.napaCredits || 0;
        const customerData = {
            name: order.customerName || customer?.name || '',
            phone: order.phoneKey,
            completedOrders: (customer?.completedOrders || 0) + 1,
            totalSpentCents: (customer?.totalSpentCents || 0) + order.totalCents,
            purchased: {
                clasico: (purchased.clasico || 0) + (order.items?.clasico || 0),
                bocadillo: (purchased.bocadillo || 0) + (order.items?.bocadillo || 0)
            },
            napaCredits: 0,
            updatedAt: serverTimestamp()
        };
        if (!customer) customerData.createdAt = serverTimestamp();
        if (referrer) customerData.referredBy = referrerPhone;
        tx.set(customerRef, customerData, { merge: true });

        if (referrer) {
            tx.update(referrerRef, {
                napaCredits: (referrer.napaCredits || 0) + 1,
                referralsCount: (referrer.referralsCount || 0) + 1,
                updatedAt: serverTimestamp()
            });
            orderUpdate.referralRewarded = true;
        }

        orderUpdate.creditsRedeemed = creditsRedeemed;
        tx.update(orderRef, orderUpdate);
        return { creditsRedeemed, referrerRewarded: Boolean(referrer) };
    });
}
