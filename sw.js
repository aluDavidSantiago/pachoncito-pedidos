// Service Worker básico de Pachoncito: hace la app instalable y mantiene la carcasa disponible sin conexión.
// Estrategia "red primero": siempre se sirve la versión publicada más reciente y la caché solo se usa sin conexión,
// así nunca se mezclan archivos de versiones distintas tras un despliegue.
// Sube CACHE_VERSION si cambias la lista de archivos de SHELL.
const CACHE_VERSION = 'pachoncito-v8';

const SHELL = [
    './',
    'index.html',
    'acceso.html',
    'cuenta.html',
    'resenas.html',
    'style.css',
    'manifest.json',
    'icons/logo-blanco.png',
    'icons/logo-tinta.png',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/favicon-dark-48.png',
    'icons/favicon-light-48.png',
    'script.js',
    'acceso.js',
    'cuenta.js',
    'resenas.js',
    'shared.js',
    'env.js',
    'firebase.js',
    'auth.js',
    'session.js',
    'orders.js',
    'firebase-config.js',
    'icons.js',
    'faq.js',
    'ui.js',
    'pwa.js'
];

// SDK de Firebase (otro origen): también se guarda para que la app arranque sin conexión
const CACHEABLE_HOSTS = [self.location.host, 'www.gstatic.com'];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then(cache => cache.addAll(SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE_VERSION).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);

    // Solo lecturas de nuestros archivos y del SDK. Firestore/Auth (APIs) y el panel nunca pasan por la caché.
    if (request.method !== 'GET' || !CACHEABLE_HOSTS.includes(url.host) || url.pathname.includes('admin')) return;

    event.respondWith(
        fetch(request)
            .then(response => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_VERSION).then(cache => cache.put(request, copy));
                }
                return response;
            })
            .catch(async () => {
                const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
                if (cached) return cached;
                if (request.mode === 'navigate') return caches.match('index.html');
                return Response.error();
            })
    );
});
