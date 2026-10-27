// Instancia de Firebase de los CLIENTES (pedido, cuenta, reseñas, acceso).
// El panel del obrador usa su propia instancia aislada: admin-firebase.js.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { connectFirestoreEmulator, getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { EMULATORS, USE_EMULATORS } from "./env.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

if (USE_EMULATORS) connectFirestoreEmulator(db, EMULATORS.firestoreHost, EMULATORS.firestorePort);
