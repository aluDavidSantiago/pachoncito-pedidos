// Comportamiento de interfaz común: respuesta táctil, salida animada de los diálogos y latidos de valores.
// Solo toca clases y eventos de la interfaz; no interviene en Firebase ni en los flujos de pedido.

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
}

// Sin zoom: iOS Safari ignora user-scalable=no, así que se bloquean también el pellizco (gesture*),
// el pellizco con varios dedos y el doble toque (touch-action en style.css); en escritorio, Ctrl + rueda y Ctrl +/−
function blockZoom() {
    const prevent = event => event.preventDefault();
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(type => document.addEventListener(type, prevent, { passive: false }));
    document.addEventListener('touchmove', event => { if (event.touches.length > 1) event.preventDefault(); }, { passive: false });
    document.addEventListener('wheel', event => { if (event.ctrlKey) event.preventDefault(); }, { passive: false });
    document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && ['+', '-', '=', '0'].includes(event.key)) event.preventDefault();
    });
}
