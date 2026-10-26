// PWA: registro del Service Worker e invitación a instalar la app
// (botón nativo en Android/Chrome con beforeinstallprompt; guía de 2 pasos en Safari/iOS).
import { el, storage } from "./shared.js";

const DISMISS_KEY = 'pachoncito_install_dismissed';
const DISMISS_DAYS = 14;
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); // la invitación la mostramos nosotros, de forma sutil
    deferredPrompt = event;
    document.dispatchEvent(new Event('pachoncito:install-change'));
});

window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    document.dispatchEvent(new Event('pachoncito:install-change'));
});

export function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').catch(error => console.warn('Service Worker no registrado:', error));
}

export const isStandalone = () =>
    matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const isIOS = () =>
    /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function dismissedRecently() {
    const at = storage.get(DISMISS_KEY);
    return typeof at === 'number' && Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

function installCard(content, onDismiss) {
    return el('aside', { className: 'install-card', 'aria-label': 'Instalar la app' },
        el('img', { src: 'icons/icon-192.png', alt: '', width: 48, height: 48, className: 'install-icon' }),
        el('div', { className: 'install-body' }, content),
        el('button', { type: 'button', className: 'install-close', 'aria-label': 'Ahora no', onClick: onDismiss }, '✕')
    );
}

// Pinta la invitación en `container` si procede. Con { afterSignup: true } (tras el alta)
// se muestra aunque se hubiera descartado antes.
export function mountInstallPrompt(container, { afterSignup = false } = {}) {
    if (!container) return;

    const dismiss = () => {
        storage.set(DISMISS_KEY, Date.now());
        container.replaceChildren();
    };

    const render = () => {
        if (isStandalone() || (!afterSignup && dismissedRecently())) {
            container.replaceChildren();
            return;
        }

        if (deferredPrompt) {
            const install = async () => {
                const prompt = deferredPrompt;
                deferredPrompt = null;
                prompt.prompt();
                await prompt.userChoice;
                render();
            };
            container.replaceChildren(installCard([
                el('strong', { text: '📲 Instala Pachoncito' }),
                el('p', { text: 'Pide en un toque desde tu pantalla de inicio, como una app.' }),
                el('button', { type: 'button', className: 'btn btn-small btn-install', onClick: install }, 'Instalar app')
            ], dismiss));
        } else if (isIOS()) {
            container.replaceChildren(installCard([
                el('strong', { text: '📲 Añade Pachoncito a tu inicio' }),
                el('ol', { className: 'install-steps' },
                    el('li', {}, 'Pulsa ', el('strong', { text: 'Compartir' }), ' ', el('span', { className: 'ios-share', 'aria-hidden': 'true', text: '⎙' }), ' en la barra de Safari.'),
                    el('li', {}, 'Elige ', el('strong', { text: '«Añadir a pantalla de inicio»' }), '.')
                )
            ], dismiss));
        } else {
            container.replaceChildren();
        }
    };

    render();
    document.addEventListener('pachoncito:install-change', render);
}
