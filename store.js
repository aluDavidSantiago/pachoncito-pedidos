// Estado del obrador (abierto / en descanso) en settings/store: lo cambia el panel y la carta lo escucha en tiempo real.
// firestore.rules lo deja leer a cualquiera y rechaza pedidos nuevos mientras open == false.
import { doc, onSnapshot, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const storeRef = db => doc(db, 'settings', 'store');

// Sin documento (o sin el campo) el obrador está abierto. Si la lectura falla no se llama a onChange
// (la carta sigue abierta y las reglas deciden al reservar).
export function watchStore(db, onChange, onError) {
    return onSnapshot(storeRef(db), snap => onChange(snap.data()?.open !== false), error => {
        console.error('Error al leer el estado del obrador:', error);
        onError?.(error);
    });
}

export function setStoreOpen(db, open) {
    return setDoc(storeRef(db), { open, updatedAt: serverTimestamp() }, { merge: true });
}
