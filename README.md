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
| `index.html` + `script.js` | Carta y pedido (requiere sesión) |
| `acceso.html` + `acceso.js` | Acceso con Google, alta del cliente con vinculación de teléfono e invitación a instalar |
| `cuenta.html` + `cuenta.js` | Mi cuenta: ñapas, historial de pedidos y código de invitación |
| `resenas.html` + `resenas.js` | Valoraciones anónimas (una por cliente y producto) |
| `admin.html` + `admin.js` | Panel del obrador (email y contraseña) |
| `admin-firebase.js` | Instancia de Firebase **exclusiva del panel**: su sesión nunca se mezcla con la de los clientes |
| `admin-costs.js` | Monitor de costes: proveedores reales, precio actual frente al anterior, margen por pandebono y lista de la compra |
| `admin-biometric.js` | Desbloqueo del panel con Face ID / Touch ID / huella (WebAuthn) sobre la sesión guardada en el dispositivo |
| `ui.js` / `icons.js` / `faq.js` | Interfaz común: diálogos animados, avisos, iconos SVG y preguntas frecuentes |
| `firebase-config.js` | Configuración pública del proyecto |
| `firebase.js` / `auth.js` | Instancia de Firebase de los clientes (Firestore / Auth) y conexión a emuladores |
| `session.js` | Guardia de navegación y sesión del cliente |
| `env.js` | Entorno (local/producción), modo pruebas, teléfonos y clientes de prueba |
| `shared.js` | Precios, regla de ñapas y utilidades comunes |
| `orders.js` | Construcción y entrega de pedidos (la usan web, panel y generador) |
| `seeder.js` | Generador de datos de prueba del panel |
| `pwa.js` + `sw.js` + `manifest.json` + `icons/` | App instalable (PWA) y funcionamiento básico sin conexión |
| `style.css` | Hoja de estilos única con variables CSS |
| `firestore.rules` | Reglas de seguridad de la base de datos |

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

## Antifraude: un teléfono, una cuenta

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
* **Por feedback:** desde el panel se premia la primera reseña de cada cliente con 1 ñapa.
* Las ñapas acumuladas aparecen en el siguiente pedido del cliente en el panel y se canjean al entregarlo.
* Los clientes anteriores a las cuentas de Google (identificados por teléfono) se fusionan automáticamente con su nueva cuenta al entregarles el primer pedido.

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
