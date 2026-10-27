// Configuración pública del proyecto de Firebase (no es secreta: la seguridad la ponen firestore.rules).
// Separada de firebase.js para que el panel cree su propia instancia sin inicializar la de los clientes.
export const firebaseConfig = {
    apiKey: "AIzaSyCd0fYKBpOj5tVzE3S3yN71IbTvyPXsFZw",
    authDomain: "pachoncito-pedidos.firebaseapp.com",
    projectId: "pachoncito-pedidos",
    storageBucket: "pachoncito-pedidos.firebasestorage.app",
    messagingSenderId: "7692189366",
    appId: "1:7692189366:web:6062b058010173d0f07017",
    measurementId: "G-FEWQ71E7TF"
};
