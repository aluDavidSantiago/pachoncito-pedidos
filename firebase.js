// Inicialización única de Firebase para todas las páginas
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

export const firebaseConfig = {
    apiKey: "AIzaSyCd0fYKBpOj5tVzE3S3yN71IbTvyPXsFZw",
    authDomain: "pachoncito-pedidos.firebaseapp.com",
    projectId: "pachoncito-pedidos",
    storageBucket: "pachoncito-pedidos.firebasestorage.app",
    messagingSenderId: "7692189366",
    appId: "1:7692189366:web:6062b058010173d0f07017",
    measurementId: "G-FEWQ71E7TF"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
