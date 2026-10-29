// Comportamiento de interfaz común: respuesta táctil, salida animada de los diálogos y latidos de valores.
// Solo toca clases y eventos de la interfaz; no interviene en Firebase ni en los flujos de pedido.
import { icon } from "./icons.js";
import { APP_VERSION, el } from "./shared.js";
import { isSoundEnabled, playTap, setSoundEnabled } from "./sound.js";

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Cierra un <dialog> con su animación de salida (.is-closing); el nativo desaparecería de golpe
export function closeDialog(dialog) {
    if (!dialog?.open || dialog.classList.contains('is-closing')) return;
    if (reducedMotion()) {
        dialog.close();
        return;
    }
    dialog.classList.add('is-closing');
    const finish = () => {
        dialog.classList.remove('is-closing');
        dialog.close();
    };
    dialog.addEventListener('animationend', finish, { once: true });
    setTimeout(() => dialog.classList.contains('is-closing') && finish(), 400); // red de seguridad
}

// Escape y pulsación fuera del contenido cierran con animación
export function enhanceDialog(dialog) {
    if (dialog.dataset.enhanced) return;
    dialog.dataset.enhanced = 'true';
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        closeDialog(dialog);
    });
    dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const box = dialog.getBoundingClientRect();
        const inside = event.clientX >= box.left && event.clientX <= box.right
            && event.clientY >= box.top && event.clientY <= box.bottom;
        if (!inside) closeDialog(dialog); // clic en el fondo difuminado
    });
}

// Pequeño latido al cambiar un valor (cantidades, total). Reinicia la animación aunque se repita seguido.
export function bump(node) {
    if (!node || reducedMotion()) return;
    node.classList.remove('bump');
    void node.offsetWidth;
    node.classList.add('bump');
}

// Aviso flotante (vidrio esmerilado) que entra desde abajo y se retira solo
let toastNode = null;
let toastTimer = null;

export function toast(text, type = 'info') {
    if (!toastNode) {
        toastNode = document.createElement('div');
        toastNode.className = 'toast';
        toastNode.setAttribute('role', 'status');
        toastNode.setAttribute('aria-live', 'polite');
        document.body.append(toastNode);
    }
    toastNode.textContent = text;
    toastNode.dataset.type = type;
    toastNode.classList.remove('is-visible');
    void toastNode.offsetWidth;
    toastNode.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastNode.classList.remove('is-visible'), type === 'error' ? 6000 : 3500);
}

export function initUI() {
    // iOS Safari solo aplica :active (la respuesta al tocar) si la página escucha toques
    document.addEventListener('touchstart', () => {}, { passive: true });
    document.querySelectorAll('dialog').forEach(enhanceDialog);
    blockZoom();
    mountVersion();
}

// Indicador de versión: texto informativo dentro del pie (o al final de la tarjeta / del panel si no hay pie), sin enlaces
function mountVersion() {
    const host = document.querySelector('.site-footer') || document.querySelector('.container, .admin-container') || document.body;
    host.append(el('p', { className: 'app-version', text: `Pachoncito v${APP_VERSION}` }));
}

// Sin zoom: iOS Safari ignora user-scalable=no, así que se bloquea el pellizco (gesture*) y el doble toque
// (touch-action en style.css); en escritorio, Ctrl + rueda y Ctrl +/−. Sin escuchar touchmove: así el
// desplazamiento sigue en el hilo del compositor y no espera al JavaScript.
function blockZoom() {
    const prevent = event => event.preventDefault();
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(type => document.addEventListener(type, prevent, { passive: false }));
    document.addEventListener('wheel', event => { if (event.ctrlKey) event.preventDefault(); }, { passive: false });
    document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && ['+', '-', '=', '0'].includes(event.key)) event.preventDefault();
    });
}

// Barra superior: nombre y ñapas del cliente. En la página de pedido, «Hacer pedido» desplaza a los productos.
export function mountTopNav(profile) {
    document.querySelectorAll('[data-nav-name]').forEach(node => { node.textContent = profile.name.split(' ')[0]; });
    document.querySelectorAll('[data-nav-napas]').forEach(node => { node.textContent = profile.napaCredits || 0; });
    mountSoundToggle();
    const target = document.getElementById('pedido');
    const cta = document.querySelector('[data-nav-order]');
    if (!target || !cta) return;
    cta.addEventListener('click', event => {
        event.preventDefault();
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        target.querySelector('button')?.focus({ preventScroll: true });
    });
}

// Silencio / sonido en la barra superior; la preferencia se recuerda en este dispositivo (sound.js)
function mountSoundToggle() {
    const button = document.querySelector('[data-sound-toggle]');
    if (!button) return;
    const render = () => {
        const on = isSoundEnabled();
        button.setAttribute('aria-pressed', String(on));
        button.title = on ? 'Sonido activado' : 'Sonido silenciado';
        button.replaceChildren(icon(on ? 'soundOn' : 'soundOff'));
    };
    button.addEventListener('click', () => {
        setSoundEnabled(!isSoundEnabled());
        render();
        playTap(); // confirma que vuelve a sonar (si se ha silenciado, no suena)
    });
    render();
}

// Rebote elástico de una tarjeta (al añadir un producto). Web Animations: solo transform, en el compositor
export function nudge(node) {
    if (reducedMotion() || !node.animate) return;
    node.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.025)' }, { transform: 'scale(1)' }],
        { duration: 420, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
    );
}
