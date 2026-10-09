// Importa Firebase desde CDN (Modular v10)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Configuración oficial de tu proyecto en Firebase
const firebaseConfig = {
    apiKey: "AIzaSyCd0fYKBpOj5tVzE3S3yN71IbTvyPXsFZw",
    authDomain: "pachoncito-pedidos.firebaseapp.com",
    projectId: "pachoncito-pedidos",
    storageBucket: "pachoncito-pedidos.firebasestorage.app",
    messagingSenderId: "7692189366",
    appId: "1:7692189366:web:6062b058010173d0f07017",
    measurementId: "G-FEWQ71E7TF"
};

// Inicializar Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const prices = {
    clasico: 1.50,
    bocadillo: 1.70
};

window.changeQty = function(product, delta) {
    const input = document.getElementById(product);
    let currentVal = parseInt(input.value) || 0;
    currentVal += delta;
    if (currentVal < 0) currentVal = 0;
    input.value = currentVal;
    updateSummary();
};

function updateSummary() {
    const clasicoQty = parseInt(document.getElementById('clasico').value) || 0;
    const bocadilloQty = parseInt(document.getElementById('bocadillo').value) || 0;
    
    let subtotal = (clasicoQty * prices.clasico) + (bocadilloQty * prices.bocadillo);
    
    const tipoEntrega = document.getElementById('tipoEntrega').value;
    let deliveryCost = tipoEntrega === 'domicilio' ? 1.00 : 0.00;
    
    let total = subtotal + deliveryCost;
    document.getElementById('totalPrice').innerText = total.toFixed(2);

    const alertBox = document.getElementById('napaAlert');

    // MODIFICACIÓN: Las ñapas se calculan cada 10€ del total (incluyendo el envío)
    const napaCount = Math.floor(total / 10);

    if (napaCount > 0) {
        alertBox.style.borderColor = '#4ade80';
        alertBox.style.color = '#4ade80';
        alertBox.style.background = 'rgba(74, 222, 128, 0.08)';
        alertBox.innerHTML = `🎉 ¡Felicidades! Te has ganado <strong>${napaCount} ${napaCount === 1 ? 'Ñapa gratis' : 'Ñapas gratis'}</strong> 🥖✨`;
    } else {
        alertBox.style.borderColor = 'rgba(223, 155, 58, 0.3)';
        alertBox.style.color = '#df9b3a';
        alertBox.style.background = 'rgba(223, 155, 58, 0.08)';
        let faltante = (10.00 - total).toFixed(2);
        alertBox.innerHTML = `🎁 ¡Añade <span id="faltante">${faltante}</span>€ más para llevarte tu primera Ñapa gratis!`;
    }
}

window.toggleDireccion = function() {
    const tipoEntrega = document.getElementById('tipoEntrega').value;
    const direccionBox = document.getElementById('direccionBox');
    
    if (tipoEntrega === 'domicilio') {
        direccionBox.style.display = 'block';
        direccionBox.style.opacity = '0';
        direccionBox.style.transform = 'translateY(-6px)';
        setTimeout(() => {
            direccionBox.style.opacity = '1';
            direccionBox.style.transform = 'translateY(0)';
        }, 10);
    } else {
        direccionBox.style.opacity = '0';
        direccionBox.style.transform = 'translateY(-6px)';
        setTimeout(() => {
            direccionBox.style.display = 'none';
        }, 300);
    }
    updateSummary();
}

document.getElementById('orderForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    
    const nombre = document.getElementById('nombre').value.trim();
    const telefono = document.getElementById('telefono').value.trim();
    const clasicoQty = parseInt(document.getElementById('clasico').value) || 0;
    const bocadilloQty = parseInt(document.getElementById('bocadillo').value) || 0;
    const tipoEntrega = document.getElementById('tipoEntrega').value;
    const direccion = document.getElementById('direccion').value.trim();
    const hora = document.getElementById('hora').value;
    const subtotal = (clasicoQty * prices.clasico) + (bocadilloQty * prices.bocadillo);
    const deliveryCost = tipoEntrega === 'domicilio' ? 1.00 : 0.00;
    const total = subtotal + deliveryCost;

    if (clasicoQty === 0 && bocadilloQty === 0) {
        alert('Por favor, selecciona al menos un pandebono para tu pedido.');
        return;
    }

    if (tipoEntrega === 'domicilio' && !direccion) {
        alert('Por favor, introduce tu dirección exacta en Premià de Mar.');
        return;
    }

    if (!hora) {
        alert('Por favor, selecciona una hora de entrega.');
        return;
    }

    const submitBtn = document.querySelector('.btn-primary');
    submitBtn.disabled = true;
    submitBtn.innerText = 'Guardando pedido... ⏳';

    try {
        // MODIFICACIÓN: Se calcula el número de ñapas basado en el total (incluyendo envío)
        const earnedNapas = Math.floor(total / 10);

        const orderData = {
            customerName: nombre,
            phone: telefono,
            items: {
                clasico: clasicoQty,
                bocadillo: bocadilloQty
            },
            subtotal: subtotal,
            hasNapa: earnedNapas > 0,
            napaCount: earnedNapas, // Guardamos la cantidad exacta de ñapas ganadas
            deliveryMethod: tipoEntrega,
            address: tipoEntrega === 'domicilio' ? direccion : 'Recogida en local',
            deliverySlot: hora,
            total: total,
            status: 'pending',
            createdAt: serverTimestamp()
        };

        // Guardar en la colección 'orders' de Firestore
        await addDoc(collection(db, "orders"), orderData);

        alert(`¡Pedido realizado con éxito, ${nombre}! Nos vemos este domingo 🥖🔥`);
        
        document.getElementById('orderForm').reset();
        document.getElementById('clasico').value = 0;
        document.getElementById('bocadillo').value = 0;
        toggleDireccion();
        updateSummary();

    } catch (error) {
        console.error("Error al guardar el pedido: ", error);
        alert("Hubo un error al procesar tu reserva. Por favor, inténtalo de nuevo.");
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerText = 'Reservar para este Domingo 🥖';
    }
});

window.addEventListener('DOMContentLoaded', () => {
    toggleDireccion();
    updateSummary();
});