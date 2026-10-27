// Iconos de línea (24×24, trazo con currentColor) para sustituir a los emojis en la interfaz.
// En el HTML basta con <span data-icon="nombre"></span>; hydrateIcons() los convierte en SVG.
const SVG_NS = 'http://www.w3.org/2000/svg';

// Marcado constante y propio (nunca datos de usuario)
const ICONS = {
    clipboard: '<rect x="5.5" y="4" width="13" height="17" rx="2"/><path d="M9 4.5h6V7H9zM9 11h6M9 14.5h6M9 18h3.5"/>',
    milk: '<path d="M9 2.5h6V5l2.5 3.5V21h-11V8.5L9 5z"/><path d="M6.5 8.5h11M10 13.5h4"/>',
    egg: '<path d="M12 3C8.6 3 5.5 8.3 5.5 13a6.5 6.5 0 0 0 13 0C18.5 8.3 15.4 3 12 3z"/>',
    alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.1"/>',
    flame: '<path d="M12 3c1 3.6 5.5 5.6 5.5 10.2a5.5 5.5 0 0 1-11 0c0-2.6 1.6-4.3 2.6-5.7.5 2 1.6 3.1 2.6 3.1 0-2.6-1-5 .3-7.6z"/>',
    question: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.7.3-1.2.9-1.2 1.7v.6M12 17.2v.1"/>',
    shield: '<path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
    chat: '<path d="M20 12a8 8 0 0 1-11.7 7.1L4 20l1-4A8 8 0 1 1 20 12z"/><path d="M8.5 11h7M8.5 14h4.5"/>',
    instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5v.1"/>',
    whatsapp: '<path d="M4 20l1.3-3.9A8.5 8.5 0 1 1 8 18.8z"/><path d="M9 8.8c-.3 2.9 2.6 6.1 5.9 6.3l1.1-1.4-2-1.2-1 .9c-1.2-.5-2.1-1.4-2.6-2.6l.9-1-1.2-2z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.6 4.2-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/>',
    gift: '<rect x="3.5" y="8" width="17" height="4.5" rx="1"/><path d="M5 12.5V20h14v-7.5M12 8v12M12 8c-1.5-3.5-6-3.6-6-1 0 1 1 1 2 1zm0 0c1.5-3.5 6-3.6 6-1 0 1-1 1-2 1z"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
    bread: '<path d="M5 11a7 4.5 0 0 1 14 0v8H5z"/><path d="M5 11h14M9.5 13.5l1-2M13.5 13.5l1-2"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    chevron: '<path d="M7 10l5 5 5-5"/>'
};

export function icon(name, className = 'icon') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', className);
    svg.innerHTML = ICONS[name] || '';
    return svg;
}

// Sustituye cada <span data-icon="nombre" class="…"> por su SVG (conserva las clases del span)
export function hydrateIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach(slot => {
        slot.replaceWith(icon(slot.dataset.icon, `icon ${slot.className}`.trim()));
    });
}
