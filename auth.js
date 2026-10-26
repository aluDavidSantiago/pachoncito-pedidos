// Firebase Auth compartido (panel, cuenta y reseñas). La página de pedido no lo carga.
import { connectAuthEmulator, getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { EMULATORS, USE_EMULATORS } from "./env.js";
import { app } from "./firebase.js";

export const auth = getAuth(app);
auth.languageCode = 'es';

if (USE_EMULATORS) connectAuthEmulator(auth, EMULATORS.authUrl, { disableWarnings: true });
