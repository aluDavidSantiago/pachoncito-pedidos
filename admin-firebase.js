// Instancia de Firebase EXCLUSIVA del panel del obrador.
// Firebase guarda la sesión por nombre de app: con "obrador" la sesión del panel (email y contraseña)
// nunca se mezcla ni se sustituye con la de un cliente que entre con Google en el mismo navegador.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { connectAuthEmulator, getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { connectFirestoreEmulator, getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { EMULATORS, USE_EMULATORS } from "./env.js";
import { firebaseConfig } from "./firebase-config.js";

export const adminApp = initializeApp(firebaseConfig, 'obrador');
export const adminAuth = getAuth(adminApp);
export const adminDb = getFirestore(adminApp);

if (USE_EMULATORS) {
    connectAuthEmulator(adminAuth, EMULATORS.authUrl, { disableWarnings: true });
    connectFirestoreEmulator(adminDb, EMULATORS.firestoreHost, EMULATORS.firestorePort);
}
