// Sesión del cliente y "auth wall" de las páginas de cliente.
// La guardia es la capa de experiencia: la seguridad real está en firestore.rules (canActAs).
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { auth } from "./auth.js";
import { isTestPhone } from "./env.js";
import { db } from "./firebase.js";
import { storage } from "./shared.js";

const TEST_SESSION_KEY = 'pachoncito_test_session';

// ---------- Sesiones de prueba (sin SMS, solo teléfonos de prueba) ----------

export function startTestSession(phone) {
    if (isTestPhone(phone)) storage.set(TEST_SESSION_KEY, phone);
}

function readTestSession() {
    const phone = storage.get(TEST_SESSION_KEY);
    return isTestPhone(phone) ? phone : null;
}

// ---------- Sesión actual ----------

// { phone, uid, isTest, isTestSession } o null. Firebase recuerda la sesión real entre visitas
// (también al abrir la app instalada), así que el cliente solo verifica su móvil una vez.
export function getSession() {
    return new Promise(resolve => {
        const unsubscribe = onAuthStateChanged(auth, user => {
            unsubscribe();
            const testPhone = readTestSession();
            if (testPhone) {
                resolve({ phone: testPhone, uid: 'test', isTest: true, isTestSession: true });
            } else if (user?.phoneNumber) {
                resolve({ phone: user.phoneNumber, uid: user.uid, isTest: isTestPhone(user.phoneNumber), isTestSession: false });
            } else {
                resolve(null);
            }
        });
    });
}

export async function endSession() {
    storage.remove(TEST_SESSION_KEY);
    await signOut(auth);
}

// ---------- Expediente del cliente (customers/{teléfono}) ----------

export async function getProfile(phone) {
    const snap = await getDoc(doc(db, 'customers', phone));
    return snap.exists() ? snap.data() : null;
}

export const hasCompletedProfile = profile => Boolean(profile?.name);

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
// También exige el alta completa (expediente con nombre) antes de entrar.
export async function requireCustomer() {
    const session = await getSession();
    if (!session) return redirectToLogin();

    let profile = null;
    try {
        profile = await getProfile(session.phone);
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
