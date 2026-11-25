# Pachoncito Pedidos

Plataforma web desarrollada para la gestión, procesamiento y control de pedidos de pandebonos artesanales en Premià de Mar. El proyecto consta de una interfaz orientada al cliente para la realización de reservas y un panel de administración conectado en tiempo real.

## Caracteristicas Principales

* **Interfaz de Cliente:** Sistema intuitivo de selección de productos (clásicos y rellenos de bocadillo de guayaba), cálculo dinámico de subtotales, gestión de franjas horarias de entrega y selección entre recogida en local o envío a domicilio.
* **Cuentas de cliente con Google:** acceso en un toque, sin SMS ni contraseñas nuevas, con historial de pedidos y saldo de ñapas.
* **Control de Promociones:** ñapas por volumen de compra, por invitar a amigos y por valorar, protegidas frente a multicuenta (un teléfono = una cuenta).
* **Gestión en Tiempo Real:** Sincronización instantánea de los pedidos mediante bases de datos en la nube para el seguimiento directo por parte del equipo de obrador.
* **App instalable (PWA)** y diseño adaptado a móviles.

## Tecnologias Utilizadas

* **Frontend:** HTML5, CSS3 (Custom Properties, Flexbox, Grid) y JavaScript (ES Modules).
* **Backend y Base de Datos:** Firebase Authentication (Google, email/contraseña, anónimo para pruebas) y Firestore.
* **Control de Versiones:** Git y GitHub.

## Estructura

| Archivo | Función |
|---|---|
| `index.html` + `script.js` | Carta (pública, con fotos) y pedido (la cuenta se pide al reservar) |
| `img/` | Fotos de la carta (`clasico`, `bocadillo` en WebP + JPG) y vista previa para redes (`og-pachoncito.jpg`, 1200×630) |
| `acceso.html` + `acceso.js` | Acceso con Google, alta del cliente con vinculación de teléfono e invitación a instalar |
| `cuenta.html` + `cuenta.js` | Mi cuenta: ñapas, historial de pedidos y código de invitación |
| `seguimiento.html` + `seguimiento.js` | Seguimiento de un pedido en vivo: estado y, en reparto, mapa con el repartidor y tiempo de llegada |
| `resenas.html` + `resenas.js` | Valoraciones anónimas (una por cliente y producto) |
| `admin.html` + `admin.js` | Panel del obrador (email y contraseña) |
| `admin-firebase.js` | Instancia de Firebase **exclusiva del panel**: su sesión nunca se mezcla con la de los clientes |
| `admin-delivery.js` | Reparto en directo: «Salgo a repartir», envío de la ubicación, tiempo de llegada (OSRM) y «Entregado» |
| `address.js` | Dirección a domicilio: sugerencias de calles de Premià, piso/puerta aparte y alfiler para confirmar la puerta |
| `geo.js` | Distancias y tiempo de llegada en línea recta (compartido por panel y seguimiento) |
| `map-style.js` | Mapa del seguimiento con los colores de la web (OpenFreeMap recoloreado, claro y oscuro) y decodificador de rutas |
| `admin-cost-monitor.js` | Monitor de costes (solo lógica; los datos están en Firestore, solo para el obrador): proveedores, precio actual frente al anterior, margen por pandebono y lista de la compra |
| `admin-biometric.js` | Desbloqueo del panel con Face ID / Touch ID / huella (WebAuthn) sobre la sesión guardada en el dispositivo |
| `ui.js` / `icons.js` / `faq.js` | Interfaz común: diálogos animados, avisos, iconos SVG y preguntas frecuentes |
| `firebase-config.js` | Configuración pública del proyecto |
| `firebase.js` / `auth.js` | Instancia de Firebase de los clientes (Firestore / Auth) y conexión a emuladores |
| `session.js` | Guardia de navegación y sesión del cliente |
| `env.js` | Entorno (local/producción), modo pruebas, teléfonos y clientes de prueba |
| `shared.js` | Precios, regla de ñapas y utilidades comunes |
| `store.js` | Estado del obrador (abierto / en descanso) en `settings/store`: interruptor del panel y aviso en la carta |
| `orders.js` | Construcción y entrega de pedidos (la usan web, panel y generador) |
| `seeder.js` | Generador de datos de prueba del panel |
| `pwa.js` + `sw.js` + `manifest.json` + `icons/` | App instalable (PWA) y funcionamiento básico sin conexión |
| `style.css` | Hoja de estilos única con variables CSS |
| `firestore.rules` | Reglas de seguridad de la base de datos (incluido el regalo de bienvenida: `welcomeGifts`) |

> Los precios y la regla de ñapas están en `shared.js` **y** en `firestore.rules`. Si cambian, hay que actualizar ambos.

> Recorridos de cada perfil (cliente nuevo, recurrente y administrador): ver [USER_JOURNEY.md](USER_JOURNEY.md).

## Puesta en marcha (Firebase)

> Las reglas y el código van juntos: despliega `firestore.rules` y publica la web a la vez.

1. **Authentication → Método de acceso:** activa **Google** (clientes), **Correo electrónico/contraseña** (panel) y **Anónimo** (solo modo pruebas). Desactiva **Teléfono**.
2. **Authentication → Configuración → Dominios autorizados:** debe estar `aludavidsantiago.github.io` (y `localhost` para desarrollo).
3. **Crear un administrador:** en *Authentication → Usuarios* crea el usuario del obrador (email y contraseña) y copia su UID. En *Firestore* crea el documento `admins/{UID}` (puede estar vacío). Las reglas impiden crearlo desde la web.
   Usa para el panel un email que **no** uses para entrar como cliente con Google.
4. **Desplegar las reglas:**
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use pachoncito-pedidos
   firebase deploy --only firestore:rules
   ```

## Producción y costes

* **1 tanda = 8 pandebonos** (`UNITS_PER_BATCH` en `admin-cost-monitor.js`). El panel separa **Pendientes de hornear** (pedidos pendientes o en preparación) y **Horneados** (listos o entregados), y expresa lo pendiente en tandas completas de 8.
* Pago en **efectivo o Bizum** al recoger o recibir el pedido.

## Antifraude: un teléfono, una cuenta

**Validación del móvil sin SMS** (`validateMobile()` en `shared.js`, repetida en `isRealMobile()` de `firestore.rules`):
9 cifras, prefijo móvil español (6 o 71–74), sin 5 cifras iguales seguidas ni secuencias de 6 (123456 / 654321),
con máscara «612 345 678», aviso en tiempo real y un segundo campo de confirmación que no admite pegar.
Las cuentas anónimas del modo pruebas siguen usando los teléfonos ficticios; las cuentas de Google del emulador
necesitan un móvil con formato real.

Al darse de alta, el cliente vincula su teléfono/WhatsApp. Firestore guarda un cerrojo `phoneClaims/{teléfono}`
que solo se puede crear una vez: si otra cuenta de Gmail intenta usar el mismo número, el alta se rechaza.
El teléfono no se puede cambiar desde la web.

Sin SMS no se puede probar que el número sea de quien lo escribe, así que **la verificación la hace el obrador**:
al marcar el primer pedido como *Entregado* confirma el teléfono (`phoneVerified`). Las ñapas por invitación y por
reseña solo se conceden con el teléfono confirmado. Si alguien registra un número ajeno, el obrador lo libera desde
el panel (**📱 Teléfonos vinculados**).

## Cómo funcionan las ñapas

* **Por volumen:** 1 ñapa por cada 10 € del pedido (envío incluido).
* **Por invitación:** cada cliente tiene un código (p. ej. `ANA-7K3P`). Quien se da de alta con él queda vinculado; al entregarle su primer pedido, el recomendador acumula 1 ñapa (si ya tiene alguna compra entregada).
* **Por valorar:** 1 ñapa por cada pedido entregado que el cliente valora (elige el pedido y el sabor). La reseña usa el id del pedido (`reviews/{idPedido}`) y solo se crea una vez; las reglas (`isReviewReward` + `reviewableOrder`) exigen pedido propio, entregado, con ese sabor, y exactamente +1 en el mismo lote.
* Al hacer el pedido, el cliente elige cuántas de sus ñapas acumuladas canjea (de 0 al total, campo opcional `creditsToRedeem`). Las elegidas aparecen en el panel y se descuentan al entregarlo; las demás siguen en su saldo. Los pedidos antiguos sin ese campo canjean todo el saldo, como antes.
* Los clientes anteriores a las cuentas de Google (identificados por teléfono) se fusionan automáticamente con su nueva cuenta al entregarles el primer pedido.

## Carta pública y llegada desde Instagram

* **La carta se ve sin cuenta** (también dentro del navegador de Instagram): fotos, precios, regalo de bienvenida y alérgenos. La cuenta de Google solo se pide al pulsar «Reservar».
* **La cesta viaja en el enlace:** al reservar, el visitante va a `acceso.html?next=index.html?c=2&b=1&e=domicilio&h=10:00` y, al volver, la carta recupera cantidades, entrega y hora (la dirección queda guardada en el dispositivo). El enlace se limpia después.
* **Desde Instagram/Facebook** (donde Google no deja iniciar sesión): botón «Abrir en Safari» (iOS 17+, `x-safari-https://…`) o «Abrir en Chrome» (Android, `intent://…`) con la misma dirección, cesta incluida; si no se abre, las instrucciones del menú ⋯ y «Volver a la carta».
* **Invitaciones:** `index.html?ref=ABC-1234` se guarda aunque el visitante no tenga cuenta y aparece rellenado en el alta.
* **Vista previa al compartir** (Instagram, WhatsApp…): etiquetas Open Graph en `index.html` con `img/og-pachoncito.jpg`.
* Para cambiar las fotos: sustituye `img/clasico.*` / `img/bocadillo.*` (cuadradas, 480×480) y sube `CACHE_VERSION` en `sw.js`.

## Reparto en directo

* **Estados:** Recibido (`pending`) → En preparación (`preparing`) → En reparto (`delivering`, solo a domicilio) → Entregado (`completed`). Los de recogida pasan por «Listo para recoger» (`ready`).
* **Panel → Reparto → «Salgo a repartir»:** marca los pedidos a domicilio del domingo que llevas. Pasan a «En reparto» y por cada uno se crea `tracking/{idPedido}` con su destino. El móvil envía su posición (`watchPosition`) cada ~8 s si se mueve (cada 30 s si está parado) y mantiene la pantalla encendida (Wake Lock).
* **Ruta y tiempo de llegada:** una vez por minuto, una consulta a [OSRM](https://project-osrm.org/) (demo pública, gratis) por pedido, separadas 1 s. Se guarda la ruta (`route`, polilínea) para dibujarla en dorado en el mapa del cliente. Si falla, línea recta a 25 km/h con un 30 % más de recorrido (línea discontinua).
* **Dirección exacta desde el pedido:** en la carta, «Calle y número» sugiere calles reales de Premià de Mar ([Photon](https://photon.komoot.io/), OpenStreetMap; solo dentro de la zona) y «Piso, puerta…» va aparte. Al elegir la calle aparece un mini mapa con un alfiler que el cliente confirma o mueve hasta su puerta; ese punto se guarda en el pedido (`destination`, validado en `firestore.rules` · `isDeliveryPoint`) y el reparto lo usa tal cual. Si no elige sugerencia, se sitúa solo al reservar. La dirección se guarda como «Calle 12, 2º 1ª, 08330 Premià de Mar» (`address.js`).
* **Direcciones sin punto** (pedidos antiguos): se sitúan una sola vez al salir y se guardan en el pedido (`destination`). Se quita piso y puerta, se prueba la calle en castellano y en catalán («Calle Mayor» → «Carrer Mayor»), con y sin número, con [Nominatim](https://nominatim.org/) y, si no, con [Photon](https://photon.komoot.io/). Se descartan resultados a más de 15 km de Premià. Si no se encuentra, el cliente ve «Va de camino a tu casa» y la posición del repartidor, sin mensajes de error.
* **Privacidad:** la ubicación solo vive en `tracking/{idPedido}` mientras el pedido está en reparto; se **borra** al marcar «Entregado» o «Terminar reparto» (los no entregados vuelven a «Listo»). Cada cliente solo puede leer el de su pedido (`firestore.rules`). Nominatim y OSRM solo los llama el móvil del repartidor, nunca los clientes.
* **Cliente:** `seguimiento.html?pedido=…` (enlazado desde la confirmación y «Mi cuenta») muestra el estado y, en reparto, un mapa MapLibre + [OpenFreeMap](https://openfreemap.org/) (gratis, sin clave, uso comercial permitido) con los colores de la web, que se actualiza solo con `onSnapshot`: el repartidor se desliza, la ruta en dorado y el tiempo de llegada flotando encima. Solo aparecen la posición del repartidor y la dirección de entrega, nunca la ubicación del cliente.
* **Importante:** con la pantalla apagada o en otra app, el navegador deja de dar la ubicación; al volver al panel se reanuda sola.

## Regalo de bienvenida

* **1 pandebono clásico gratis** en el primer pedido que cada cliente hace en la web (los pedidos antiguos por WhatsApp no cuentan). Aparece en el carrito, en el resumen y en el historial como «Regalo de bienvenida»; no cambia precios, total ni ñapas. En el panel suma 1 a los clásicos por hornear (coste, no ingreso).
* El pedido lleva `welcomeGift: true` y crea en el mismo lote los cerrojos `welcomeGifts/{uid}` y `welcomeGifts/{teléfono}` (las cuentas de prueba, solo el de la cuenta). Las reglas (`validWelcomeGift`) solo aceptan el regalo si está activo (`settings/store.welcomeGift`), el cliente no tiene pedidos entregados (`completedOrders`, sin el campo cuenta como 0) y ninguno de sus cerrojos existía. Todo primer pedido web crea los cerrojos, lleve regalo o no.
* Las reglas no pueden buscar pedidos, así que **antes de activarlo** el panel (**Regalo de bienvenida → Preparar y activar el regalo**) crea el cerrojo a todo cliente con algún pedido web anterior. Repetirlo es seguro: solo crea los que faltan. Desde ahí también se pausa.
* Compatibilidad: los pedidos sin regalo no necesitan cerrojo, así que la versión anterior de la web sigue funcionando con las reglas nuevas, y la nueva con las antiguas (si no puede crear los cerrojos, guarda el pedido como antes).

## Pruebas

### Modo pruebas en la web publicada (`?pruebas=1`)
1. Abre `https://aludavidsantiago.github.io/pachoncito-pedidos/acceso.html?pruebas=1`.
2. Pulsa **🧪 Entrar como cliente de prueba** (sesión anónima real de Firebase; no hace falta ninguna cuenta).
3. Date de alta con un teléfono de prueba: `+34 600 000 000` a `+34 600 000 999` o `+34 600 023 456`.

Todo lo que crea una cuenta de prueba lleva `test: true` (lo exigen las reglas): no se muestra al público y
«Borrar datos de prueba» del panel lo elimina. Se apaga con `?pruebas=0`. En `localhost` está siempre activo.

### Emuladores locales (no tocan la base de datos real)
Requiere Java 11+ y `firebase-tools`.
```bash
firebase emulators:start          # Auth :9099, Firestore :8080, interfaz web :4000
python -m http.server 5500        # en otra terminal, desde la carpeta del proyecto
```
Abre `http://localhost:5500/?emuladores=1`. El botón de Google muestra **cuentas de Google ficticias** del emulador.
El emulador empieza vacío: crea el usuario del obrador y el documento `admins/{UID}` desde la interfaz web (`http://127.0.0.1:4000`).

### Generador de datos de prueba
En el panel, sección **🧪 Datos de prueba** (abajo del todo):
* **Generar / regenerar:** crea 7 clientes ficticios (`seed_*`) con teléfono vinculado y código de invitación, 8 pedidos en todos los estados y 2 reseñas. Usa la misma lógica de entrega que los pedidos reales.
  * Bruno se dio de alta con el código de Ana y está entregado: Ana tiene +1 ñapa acumulada en su pedido pendiente.
  * Carla se dio de alta con el código de Bruno y está en preparación: al entregarlo, Bruno gana su ñapa.
  * Elena usó el código de Fran, que no tiene compras: al entregarlo no premia a nadie.
* **Borrar:** elimina todo lo marcado como prueba (también las cuentas anónimas del modo pruebas). Nunca toca datos reales.

## Enlaces de Interes

* [Instagram Oficial](https://www.instagram.com/pachoncito_oficial)

## Inicio del Proyecto

El desarrollo activo del proyecto dio comienzo el 1 de octubre de 2026.
