// Modal de «Preguntas frecuentes»: tratamiento de datos, encargos y entregas, alérgenos y contacto.
// Se abre desde cualquier elemento con el atributo data-open-faq.
import { icon } from "./icons.js";
import { CONTACT, DELIVERY_CENTS, el, formatEUR } from "./shared.js";
import { closeDialog, enhanceDialog } from "./ui.js";

function faqItem(iconName, question, ...body) {
    return el('details', { className: 'faq-item' },
        el('summary', {}, icon(iconName, 'icon faq-icon'), el('span', { text: question }), icon('chevron', 'icon chevron')),
        el('div', { className: 'faq-body' }, ...body)
    );
}

function contactLinks() {
    const links = [
        el('a', {
            className: 'btn btn-secondary contact-btn',
            href: `https://ig.me/m/${CONTACT.instagram}`,
            target: '_blank',
            rel: 'noopener noreferrer'
        }, icon('instagram'), `Instagram · @${CONTACT.instagram}`)
    ];
    if (CONTACT.whatsapp) {
        links.push(el('a', {
            className: 'btn btn-secondary contact-btn',
            href: `https://wa.me/${CONTACT.whatsapp}?text=${encodeURIComponent('Hola Pachoncito, tengo una duda sobre mi pedido.')}`,
            target: '_blank',
            rel: 'noopener noreferrer'
        }, icon('whatsapp'), 'WhatsApp'));
    }
    return el('div', { className: 'contact-links' }, links);
}

function buildFaqDialog() {
    const dialog = el('dialog', { className: 'modal modal-faq', 'aria-labelledby': 'faqTitle' },
        el('div', { className: 'modal-header' },
            // autofocus: al abrir, el foco va al título y no a la ✕ (evita el aro de foco y cierres accidentales)
            el('h2', { id: 'faqTitle', tabindex: '-1', autofocus: true, text: 'Preguntas frecuentes' }),
            el('button', { type: 'button', className: 'modal-close', 'aria-label': 'Cerrar', onClick: () => closeDialog(dialog) }, icon('close'))
        ),
        el('div', { className: 'faq-list' },
            faqItem('shield', '¿Qué hacemos con tus datos?',
                el('p', { text: 'Para reservar necesitamos saber quién eres. Tu cuenta de Google (nombre y email) y el teléfono que vinculas solo los usamos, de forma interna, para:' }),
                el('ul', {},
                    el('li', { text: 'Identificar tu reserva y guardar tu historial de pedidos.' }),
                    el('li', { text: 'Saber cuántos pandebonos hornear cada domingo.' }),
                    el('li', { text: 'Avisarte si hay cualquier novedad con tu entrega en Premià de Mar.' })
                ),
                el('p', {}, el('strong', { text: 'No vendemos ni cedemos tus datos a nadie y no te enviaremos publicidad ni correos comerciales.' })),
                el('p', { className: 'faq-note', text: 'La información se guarda en Firebase, el servicio de Google que aloja esta web, únicamente para que la tienda funcione. Si quieres que borremos tu cuenta, escríbenos y lo hacemos.' })
            ),
            faqItem('calendar', '¿Cómo funcionan los encargos y las entregas?',
                el('ul', {},
                    el('li', { text: 'Las reservas están abiertas de lunes a viernes desde esta web.' }),
                    el('li', { text: 'El domingo por la mañana horneamos todos los encargos, para que te lleguen recién hechos.' }),
                    el('li', { text: `Eliges recogida en nuestro obrador de Premià de Mar o envío a domicilio (${formatEUR(DELIVERY_CENTS)}), y la franja horaria que mejor te venga.` }),
                    el('li', { text: 'En «Mi cuenta» puedes seguir el estado de tu pedido: pendiente, en preparación, listo y entregado.' })
                )
            ),
            faqItem('clipboard', '¿Qué alérgenos tienen?',
                el('p', { text: 'Nuestros pandebonos contienen lácteos (queso) y huevo, y pueden contener trazas de otros alérgenos habituales en el obrador. Encontrarás el detalle en la carta, en «Información alimentaria y alérgenos».' }),
                el('p', { text: 'Si tienes una alergia o intolerancia, escríbenos antes de hacer tu pedido.' })
            ),
            faqItem('chat', '¿Tienes alguna duda sobre tu pedido?',
                el('p', { text: 'Escríbenos y te respondemos lo antes posible.' }),
                contactLinks()
            )
        )
    );

    // Escape o pulsar sobre el fondo difuminado: cierre con animación
    enhanceDialog(dialog);
    return dialog;
}

let faqDialog = null;

export function mountFaq(root = document) {
    root.querySelectorAll('[data-open-faq]').forEach(trigger => {
        trigger.addEventListener('click', event => {
            event.preventDefault();
            if (!faqDialog) {
                faqDialog = buildFaqDialog();
                document.body.append(faqDialog);
            }
            faqDialog.showModal();
        });
    });
}
