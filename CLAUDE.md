# Pachoncito · notas para Claude

Web de pedidos de **Pachoncito**: pandebonos colombianos artesanos en **Premià de Mar (08330)**, reservas de lunes a
viernes y entregas los domingos (recogida en el obrador o a domicilio). El dueño habla español y usa iPhone/iPad.
Publicada en **https://pachoncito.es** (GitHub Pages desde `main`) con Firebase (Auth + Firestore), sin servidor propio.

## Cómo trabajar (lo que el dueño espera)
- Rama de trabajo: `claude/pandebono-welcome-first-order-vuh000`, sincronizada desde `origin/main` antes de empezar.
- Probar SIEMPRE antes de publicar: emuladores de Firebase (`firebase emulators:exec --only auth,firestore`) + Playwright
  en el navegador. Hay que simular las CDN/servicios externos (gstatic, unpkg, OpenFreeMap, OSRM, ntfy; Google Places sí responde si se manda Referer pachoncito.es):
  desde el entorno de Claude no son accesibles.
- Publicar = PR a `main` y fusionarlo (el dueño lo ha autorizado repetidamente). Subir `APP_VERSION` (shared.js),
  los `?v=` de los HTML y `CACHE_VERSION` en sw.js en cada versión.
- Si cambia `firestore.rules`, **enviarle el archivo** y recordarle publicarlo en Firebase → Firestore → Reglas.
- No romper lo que funciona: regalo de bienvenida, ñapas, reseñas, invitaciones, reparto, panel. La vista vertical no
  debe cambiar al tocar estilos de horizontal.
- Explicaciones al dueño: en español, claras, sin jerga; avisar de lo que no se pudo probar de verdad.
- Pidió NO usar Cloud Functions ni notificaciones push de Firebase.

## Qué hay (ver README.md y USER_JOURNEY.md para el detalle)
- Carta pública (sin cuenta, también desde Instagram), cuenta con Google al reservar, cesta en el enlace.
- Regalo de bienvenida (1 clásico gratis en el primer pedido web) con cerrojos `welcomeGifts`.
- Ñapas (cada 10 €, por invitar, por reseñar) y canje.
- **Horno por horas** (`oven.js`): 2 bandejas × 16 por hora, hasta 2 h de antelación (ajustable en el panel); la carta
  solo ofrece horas con horno libre; `ovenLoad/{domingo}`; plan de hornadas en el panel.
- Dirección: sugerencias SOLO con Google Places (`GOOGLE_MAPS_KEY` en shared.js; el dueño no quiere Photon/OSM) + alfiler en
  mini mapa; el punto se guarda en el pedido (`destination`).
  Clave de Google puesta (v3.0.2), restringida a `https://pachoncito.es/*` (comprobado: otras webs → PERMISSION_DENIED).
  La cuenta de Google Cloud está en prueba gratuita de 90 días (desde 26-11-2026): antes de que acabe, el dueño debe
  pulsar «Actualizar» o Google dejará de responder (no saldrían sugerencias de dirección).
- Reparto en directo: «Salgo a repartir», ubicación con watchPosition, `tracking/{pedido}` (se borra al entregar),
  mapa MapLibre + OpenFreeMap con los colores de la web, tiempo con OSRM, navegación dentro del panel (`admin-nav.js`).
- Avisos de pedido nuevo: ntfy, canal `pachoncito-obrador-530e45db990a` (`notify.js`, sin datos personales).
- Panel: producción, horno, reparto, encargos (WhatsApp con mensaje según estado, hoja del domingo imprimible),
  costes, reseñas, teléfonos, regalo, datos de prueba. Face ID con WebAuthn (llave del dispositivo).
- Optimizada para horizontal (móvil girado y iPad) con estilos solo dentro de `@media (orientation: landscape)`.

## Marca
- Logo de la espiga «Pachoncito · Date un capricho» (`icons/logo-*.png`, `1.png` en alta). Colores: crema `#f5efe6`,
  caramelo `#95560f`, dorado `#e7ad57`/`#c98a2e`, guayaba `#a8492c`; modo oscuro negro cálido `#110e0c` y ámbar.
  Títulos con serif, texto sans, mayúsculas espaciadas para detalles. Tono cercano y premium.
- Fotos de producto en `img/` (hechas por su pareja). Instagram: @pachoncito_oficial.
- Tablero de diseño (Claude artifact): https://claude.ai/artifact/1egQuKZA3gG9DpHDni9oFq — sistema de marca, etiquetas,
  tarjeta colgante para la bolsa de papel (PDF de imprenta 6×10 cm hechos aparte), caja de pizza.

## Fuera de la web
- La marca se usará también en **cajas de pizza** (otro producto): diseño «solo tapa, tinta negra», caja 30×30×4 cm,
  en el tablero de diseño. Presupuestos y datos del proveedor: los tiene el dueño (no se guardan en este repositorio,
  que es público).
