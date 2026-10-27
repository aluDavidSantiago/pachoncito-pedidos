// Sesión del cliente y "auth wall" de las páginas de cliente.
// La guardia es la capa de experiencia: la seguridad real está en firestore.rules.
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { auth } from "./auth.js";
import { db } from "./firebase.js";

// { uid, user, isTest } o null. Firebase recuerda la sesión entre visitas (también en la app instalada).
// isTest: sesión anónima del modo pruebas; las reglas obligan a marcar todo lo que cree como prueba.
export function getSession() {
    return new Promise(resolve => {
        const unsubscribe = onAuthStateChanged(auth, user => {
            unsubscribe();
            resolve(user ? { uid: user.uid, user, isTest: user.isAnonymous } : null);
        });
    });
}

export const endSession = () => signOut(auth);

// ---------- Expediente del cliente (customers/{uid}) ----------

export async function getProfile(uid) {
    const snap = await getDoc(doc(db, 'customers', uid));
    return snap.exists() ? snap.data() : null;
}

// Alta completa = nombre + teléfono vinculado (el teléfono puede quedar vacío si el obrador lo libera)
export const hasCompletedProfile = profile => Boolean(profile?.name && profile?.phone);

// ---------- Guardia de navegación ----------

// Solo páginas internas: evita redirecciones abiertas a otros dominios
export function safeNext(raw) {
    const valid = typeof raw === 'string'
        && /^[a-z0-9_-]+\.html(\?[^#\s]*)?$/i.test(raw)
        && !raw.startsWith('acceso.html');
    return valid ? raw : 'index.html';
}

export function currentRoute() {
    return (location.pathname.split('/').pop() || 'index.html') + location.search;
}

export function loginUrl(next = currentRoute()) {
    return `acceso.html?next=${encodeURIComponent(safeNext(next))}`;
}

// Devuelve { session, profile } o redirige a acceso.html y vuelve aquí tras autenticarse.
// También exige el alta completa (expediente con nombre y teléfono) antes de entrar.
export async function requireCustomer() {
    const session = await getSession();
    if (!session) return redirectToLogin();

    let profile = null;
    try {
        profile = await getProfile(session.uid);
    } catch (error) {
        console.error('No se pudo leer el expediente del cliente:', error);
    }
    if (!hasCompletedProfile(profile)) return redirectToLogin();

    document.documentElement.classList.remove('auth-pending');
    return { session, profile };
}

function redirectToLogin() {
    location.replace(loginUrl());
    return new Promise(() => {}); // la página no continúa mientras se redirige
}
