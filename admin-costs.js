// Monitor de costes del obrador: materias primas con su proveedor, precio actual frente al anterior
// y margen por pandebono. Los datos viven en Firestore y solo los lee/escribe el obrador:
//   ingredients/{id}  → formato del envase, precio, precio anterior y cantidad usada
//   settings/costs    → unidades por tanda, otros costes (envase, bolsas, luz) y versión del catálogo
//
// Cada ingrediente se usa por TANDA de masa (scope 'batch', campo usagePerBatch) o por cada pandebono de
// BOCADILLO (scope 'bocadillo', campo usagePerUnit: el relleno de guayaba).
import {
    collection, deleteField, doc, getDoc, getDocs, onSnapshot, serverTimestamp, updateDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { icon } from "./icons.js";
import { el, PRICES_CENTS, PRODUCT_NAMES } from "./shared.js";

// Sube este número cuando cambie el catálogo por defecto: ensureCostData() añadirá lo nuevo sin pisar lo editado.
const CATALOG_VERSION = 2;

// Formatos y precios consultados en la ficha de cada proveedor el 27/10/2026.
[línea retirada: dato privado del obrador]
// Cantidades: las del panel anterior; azúcar, sal y leche son estimaciones de la receta estándar (usageEstimated).
const DEFAULT_INGREDIENTS = [
[línea retirada: dato privado del obrador]
[línea retirada: dato privado del obrador]
[línea retirada: dato privado del obrador]
[línea retirada: dato privado del obrador]
[línea retirada: dato privado del obrador]
[línea retirada: dato privado del obrador]
[línea retirada: dato privado del obrador]
[línea retirada: dato privado del obrador]
    { id: 'guayaba', name: 'Pasta de guayaba (bocadillo)', supplier: 'Compra en tienda', url: null, packAmount: 1000, unit: 'g', packPriceCents: 500, scope: 'bocadillo', usagePerUnit: 15 }
];

// Del panel anterior: envase, bolsas y luz 0,74 € por tanda de 16
const DEFAULT_SETTINGS = { unitsPerBatch: 16, otherPerBatchCents: 74 };

const UNIT_LABEL = { u: 'u', g: 'g', ml: 'ml' };
const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const eurFine = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 3, maximumFractionDigits: 3 });
const money = cents => eur.format(cents / 100);
const moneyFine = cents => eurFine.format(cents / 100);

const isPerBocadillo = ing => ing.scope === 'bocadillo';
const usageOf = ing => (isPerBocadillo(ing) ? ing.usagePerUnit : ing.usagePerBatch);
const isComplete = ing => usageOf(ing) > 0 && ing.packAmount > 0 && Number.isFinite(ing.packPriceCents);

// ---------- Datos ----------

// Crea el catálogo la primera vez y, en versiones nuevas, añade lo que falte sin pisar lo editado
export async function ensureCostData(db) {
    const settingsRef = doc(db, 'settings', 'costs');
    const [ingredientsSnap, settingsSnap] = await Promise.all([getDocs(collection(db, 'ingredients')), getDoc(settingsRef)]);
    const settings = settingsSnap.exists() ? settingsSnap.data() : null;
    if ((settings?.catalogVersion || 0) >= CATALOG_VERSION && !ingredientsSnap.empty) return;

    const existing = new Map(ingredientsSnap.docs.map(d => [d.id, d.data()]));
    const batch = writeBatch(db);

    DEFAULT_INGREDIENTS.forEach(({ id, ...data }, order) => {
        const ref = doc(db, 'ingredients', id);
        const current = existing.get(id);
        if (!current) {
            batch.set(ref, {
                ...data,
                order,
                scope: data.scope || 'batch',
                previousPackPriceCents: null,
                usageEstimated: Boolean(data.usageEstimated),
                estimated: false,
                priceUpdatedAt: serverTimestamp()
            });
            return;
        }
        const patch = { order, scope: current.scope || data.scope || 'batch' };
        // Solo se completan cantidades que seguían vacías: lo que el obrador haya escrito se respeta
        if (data.usagePerBatch != null && current.usagePerBatch == null) {
            patch.usagePerBatch = data.usagePerBatch;
            patch.usageEstimated = Boolean(data.usageEstimated);
        }
[línea retirada: dato privado del obrador]
        batch.update(ref, patch);
    });

    if (settings) {
        // fillingPerUnitCents (relleno fijo) queda sustituido por el ingrediente «guayaba»
        batch.update(settingsRef, { catalogVersion: CATALOG_VERSION, fillingPerUnitCents: deleteField(), updatedAt: serverTimestamp() });
    } else {
        batch.set(settingsRef, { ...DEFAULT_SETTINGS, catalogVersion: CATALOG_VERSION, updatedAt: serverTimestamp() });
    }
    await batch.commit();
}

export function watchCostData(db, onChange, onError) {
    let ingredients = [];
    let settings = { ...DEFAULT_SETTINGS };
    const emit = () => onChange({ ingredients, settings });
    return [
        onSnapshot(collection(db, 'ingredients'), snap => {
            ingredients = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
            emit();
        }, onError),
        onSnapshot(doc(db, 'settings', 'costs'), snap => {
            settings = { ...DEFAULT_SETTINGS, ...(snap.data() || {}) };
            emit();
        }, onError)
    ];
}

export function updatePackPrice(db, ingredient, newPriceCents) {
    return updateDoc(doc(db, 'ingredients', ingredient.id), {
        previousPackPriceCents: ingredient.packPriceCents ?? null,
        packPriceCents: newPriceCents,
        estimated: false,
        priceUpdatedAt: serverTimestamp()
    });
}

// Guarda el formato del envase y la cantidad usada (por tanda o por bocadillo, según el ingrediente)
export function updateIngredientSpec(db, ingredient, { packAmount, usage }) {
    return updateDoc(doc(db, 'ingredients', ingredient.id), {
        packAmount,
        [isPerBocadillo(ingredient) ? 'usagePerUnit' : 'usagePerBatch']: usage,
        usageEstimated: false
    });
}

export function updateCostSettings(db, partial) {
    return updateDoc(doc(db, 'settings', 'costs'), { ...partial, updatedAt: serverTimestamp() });
}

// ---------- Cálculos (céntimos con decimales; se redondea solo al mostrar) ----------

function ingredientCents(ing, priceCents = ing.packPriceCents) {
    return isComplete(ing) ? (priceCents * usageOf(ing)) / ing.packAmount : 0;
}

export function unitCosts({ ingredients, settings }) {
    const units = settings.unitsPerBatch || DEFAULT_SETTINGS.unitsPerBatch;
    const batchCents = ingredients.filter(ing => !isPerBocadillo(ing))
        .reduce((sum, ing) => sum + ingredientCents(ing), 0) + (settings.otherPerBatchCents || 0);
    const fillingCents = ingredients.filter(isPerBocadillo).reduce((sum, ing) => sum + ingredientCents(ing), 0);
    const clasico = batchCents / units;
    return {
        batchCents,
        fillingCents,
        clasico,
        bocadillo: clasico + fillingCents,
        missing: ingredients.filter(ing => !isComplete(ing)).map(ing => ing.name)
    };
}

// Cuánto cambia el coste de cada pandebono (o de cada bocadillo) por el último cambio de precio
export function priceImpactPerUnit(ing, settings) {
    if (!isComplete(ing) || !Number.isFinite(ing.previousPackPriceCents)) return null;
    const delta = ingredientCents(ing) - ingredientCents(ing, ing.previousPackPriceCents);
    return isPerBocadillo(ing) ? delta : delta / (settings.unitsPerBatch || DEFAULT_SETTINGS.unitsPerBatch);
}

// Envases a comprar: la masa va por tandas (todos los pandebonos); el relleno, por cada bocadillo
export function shoppingList({ ingredients, settings }, { units, bocadillos }) {
    const perBatch = settings.unitsPerBatch || DEFAULT_SETTINGS.unitsPerBatch;
    const batches = Math.ceil(units / perBatch);
    return {
        batches,
        items: ingredients.filter(isComplete).map(ing => {
            const needed = isPerBocadillo(ing) ? bocadillos * ing.usagePerUnit : batches * ing.usagePerBatch;
            return { ing, needed, packs: Math.ceil(needed / ing.packAmount) };
        }).filter(item => item.needed > 0)
    };
}

// ---------- Interfaz ----------

function supplierLine(ing) {
    const label = `${ing.supplier} · ${ing.packAmount ?? '?'} ${UNIT_LABEL[ing.unit] || ing.unit}`;
    return ing.url
        ? el('a', { className: 'supplier-link', href: ing.url, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external'))
        : el('span', { className: 'supplier-link', text: `${label} · precio manual` });
}

function trendChip(ing) {
    const prev = ing.previousPackPriceCents;
    if (!Number.isFinite(prev) || prev === ing.packPriceCents) {
        return el('span', { className: 'trend-chip is-flat', text: Number.isFinite(prev) ? 'Sin cambios' : 'Precio inicial' });
    }
    const up = ing.packPriceCents > prev;
    return el('span', {
        className: `trend-chip ${up ? 'is-up' : 'is-down'}`,
        title: up ? 'Ha subido: alerta de coste' : 'Ha bajado: mejora de margen'
    }, icon(up ? 'arrowUp' : 'arrowDown'), `${up ? '+' : '−'}${money(Math.abs(ing.packPriceCents - prev))}`);
}

function ingredientCard(ing, settings, handlers) {
    const prev = ing.previousPackPriceCents;
    const impact = priceImpactPerUnit(ing, settings);
    const unit = UNIT_LABEL[ing.unit] || ing.unit;
    const perUnitLabel = isPerBocadillo(ing) ? 'cada pandebono de bocadillo' : 'cada pandebono';

    const priceInput = el('input', {
        type: 'number', inputmode: 'decimal', step: '0.01', min: '0',
        value: Number.isFinite(ing.packPriceCents) ? (ing.packPriceCents / 100).toFixed(2) : '',
        'aria-label': `Nuevo precio de ${ing.name}`
    });
    const save = () => handlers.onPrice(ing, priceInput);
    priceInput.addEventListener('keydown', event => { if (event.key === 'Enter') save(); });

    const amountInput = el('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: ing.packAmount ?? '', 'aria-label': 'Contenido del envase' });
    const usageInput = el('input', { type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: usageOf(ing) ?? '', 'aria-label': 'Cantidad usada' });

    return el('article', { className: 'cost-card' },
        el('header', { className: 'cost-card-head' },
            el('div', {}, el('h3', { text: ing.name }), supplierLine(ing)),
            trendChip(ing)
        ),
        el('p', { className: 'price-line' },
            Number.isFinite(prev) && prev !== ing.packPriceCents
                ? [el('span', { className: 'price-prev', text: money(prev) }), el('span', { className: 'price-arrow', 'aria-hidden': 'true', text: '→' })]
                : null,
            el('strong', { className: 'price-now', text: Number.isFinite(ing.packPriceCents) ? money(ing.packPriceCents) : '—' }),
            ing.estimated ? el('span', { className: 'price-note', text: 'estimado: confírmalo' }) : null
        ),
        impact !== null && impact !== 0
            ? el('p', { className: `impact-line ${impact > 0 ? 'is-up' : 'is-down'}` },
                `${impact > 0 ? 'Encarece' : 'Abarata'} ${perUnitLabel} ${moneyFine(Math.abs(impact))}`)
            : null,
        !isComplete(ing)
            ? el('p', { className: 'impact-line is-warning', text: 'Falta la cantidad usada: no se incluye en el coste.' })
            : null,
        ing.usageEstimated
            ? el('p', { className: 'impact-line is-warning', text: `Cantidad estimada (${usageOf(ing)} ${unit} ${isPerBocadillo(ing) ? 'por bocadillo' : 'por tanda'}): ajústala a tu receta.` })
            : null,
        el('div', { className: 'price-update' },
            el('label', { className: 'price-field' }, priceInput, el('span', { text: '€' })),
            el('button', { type: 'button', className: 'btn btn-small', onClick: save }, 'Actualizar precio')
        ),
        el('details', { className: 'recipe-spec' },
            el('summary', {}, isPerBocadillo(ing) ? 'Formato y cantidad por bocadillo' : 'Formato y cantidad por tanda', icon('chevron', 'icon chevron')),
            el('div', { className: 'spec-grid' },
                el('label', {}, el('span', { text: `Envase (${unit})` }), amountInput),
                el('label', {}, el('span', { text: isPerBocadillo(ing) ? `Por bocadillo (${unit})` : `Por tanda (${unit})` }), usageInput),
                el('button', {
                    type: 'button', className: 'btn btn-small',
                    onClick: () => handlers.onSpec(ing, amountInput, usageInput)
                }, 'Guardar')
            )
        )
    );
}

function marginRow(label, priceCents, costCents) {
    const margin = priceCents - costCents;
    const pct = priceCents ? Math.round((margin / priceCents) * 100) : 0;
    return el('div', { className: 'margin-row' },
        el('span', { className: 'margin-label', text: label }),
        el('span', { className: 'margin-cost', text: `Coste ${moneyFine(costCents)}` }),
        el('strong', { className: margin >= 0 ? 'margin-ok' : 'margin-bad', text: `${money(margin)} · ${pct} %` })
    );
}

export function renderCostMonitor(container, data, handlers) {
    const { ingredients, settings } = data;
    const costs = unitCosts(data);
    const otherInput = el('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0', value: ((settings.otherPerBatchCents || 0) / 100).toFixed(2), 'aria-label': 'Otros costes por tanda' });
    const unitsInput = el('input', { type: 'number', inputmode: 'numeric', step: '1', min: '1', value: settings.unitsPerBatch, 'aria-label': 'Pandebonos por tanda' });

    container.replaceChildren(
        el('div', { className: 'margin-panel' },
            el('div', { className: 'margin-head' },
                el('h3', {}, icon('trend'), 'Margen por pandebono'),
                el('span', { className: 'hint', text: `Tanda de ${settings.unitsPerBatch} u · masa ${money(costs.batchCents)} · relleno ${moneyFine(costs.fillingCents)}/u` })
            ),
            marginRow(PRODUCT_NAMES.clasico, PRICES_CENTS.clasico, costs.clasico),
            marginRow(PRODUCT_NAMES.bocadillo, PRICES_CENTS.bocadillo, costs.bocadillo),
            costs.missing.length
                ? el('p', { className: 'impact-line is-warning', text: `Coste incompleto: falta la cantidad usada de ${costs.missing.join(', ')}.` })
                : null
        ),
        el('div', { className: 'cost-grid' }, ingredients.map(ing => ingredientCard(ing, settings, handlers))),
        el('details', { className: 'recipe-spec other-costs' },
            el('summary', {}, 'Otros costes y tamaño de tanda', icon('chevron', 'icon chevron')),
            el('div', { className: 'spec-grid' },
                el('label', {}, el('span', { text: 'Envase, bolsas y luz por tanda (€)' }), otherInput),
                el('label', {}, el('span', { text: 'Pandebonos por tanda' }), unitsInput),
                el('button', {
                    type: 'button', className: 'btn btn-small',
                    onClick: () => handlers.onSettings(otherInput, unitsInput)
                }, 'Guardar')
            )
        )
    );
}

export function renderShoppingList(container, data, { units, bocadillos }) {
    if (!units) {
        container.replaceChildren(el('p', { className: 'empty-state', text: 'Sin pandebonos que hornear en este domingo.' }));
        return;
    }
    const { batches, items } = shoppingList(data, { units, bocadillos });
    container.replaceChildren(
        el('p', { className: 'hint', text: `${batches} ${batches === 1 ? 'tanda' : 'tandas'} de ${data.settings.unitsPerBatch} para ${units} pandebonos (${bocadillos} con bocadillo)` }),
        ...items.map(({ ing, needed, packs }) => el('div', { className: 'ingredient-item' },
            ing.url
                ? el('a', { className: 'supplier-link', href: ing.url, target: '_blank', rel: 'noopener noreferrer' }, ing.name, icon('external'))
                : el('span', { className: 'supplier-link', text: ing.name }),
            el('strong', { text: `${packs} × ${ing.packAmount} ${UNIT_LABEL[ing.unit] || ing.unit}` }),
            el('span', { className: 'hint', text: `usa ${Math.round(needed)} ${UNIT_LABEL[ing.unit] || ing.unit}` })
        ))
    );
}

// Convierte el texto de un campo de precio en céntimos enteros (acepta coma o punto)
export function parseEuros(value) {
    const number = parseFloat(String(value).replace(',', '.'));
    return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) : null;
}
