# Pachoncito Pedidos

Plataforma web desarrollada para la gestión, procesamiento y control de pedidos de pandebonos artesanales en Premià de Mar. El proyecto consta de una interfaz orientada al cliente para la realización de reservas y un panel de administración conectado en tiempo real.

## Caracteristicas Principales

* **Interfaz de Cliente:** Sistema intuitivo de selección de productos (clásicos y rellenos de bocadillo de guayaba), cálculo dinámico de subtotales, gestión de franjas horarias de entrega y selección entre recogida en local o envío a domicilio.
* **Control de Promociones:** Automatización de reglas de bonificación para la aplicación de incentivos por volumen de compra (ñapas).
* **Gestión en Tiempo Real:** Sincronización instantánea de los pedidos mediante bases de datos en la nube para el seguimiento directo por parte del equipo de obrador.
* **Diseño Adaptativo:** Maquetación moderna basada en componentes modulares con soporte para dispositivos móviles y de escritorio.

## Tecnologias Utilizadas

* **Frontend:** HTML5, CSS3 (Custom Properties, Flexbox, Grid) y JavaScript (ES Modules).
* **Backend y Base de Datos:** Firebase Firestore.
* **Control de Versiones:** Git y GitHub.

## Estructura

| Archivo | Función |
|---|---|
| `index.html` + `script.js` | Formulario de pedido (con código de referido opcional) |
| `acceso.html` + `acceso.js` | Registro / acceso por SMS |
| `resenas.html` + `resenas.js` | Valoraciones anónimas de clientes verificados |
| `admin.html` + `admin.js` | Panel del obrador (requiere login) |
| `firebase.js` / `auth.js` | Configuración única de Firebase (Firestore / Auth) y conexión a emuladores |
| `env.js` | Entorno (local/producción), modo pruebas y teléfonos de prueba |
| `shared.js` | Precios, regla de ñapas y utilidades comunes |
| `orders.js` | Construcción y entrega de pedidos (la usan web, panel y generador) |
| `seeder.js` | Generador de datos de prueba del panel |
| `phone-auth.js` | Verificación por SMS reutilizable |
| `style.css` | Hoja de estilos única con variables CSS |
| `firestore.rules` | Reglas de seguridad de la base de datos |

> Los precios y la regla de ñapas están en `shared.js` **y** en `firestore.rules`. Si cambian, hay que actualizar ambos.

## Puesta en marcha (Firebase)

1. **Authentication → Sign-in method:** activa *Correo electrónico/contraseña* (panel) y *Teléfono* (cuenta y reseñas). Añade tu dominio en *Authorized domains*.
2. **Crear un administrador:** en *Authentication → Users* crea el usuario del obrador y copia su UID. En *Firestore* crea el documento `admins/{UID}` (puede estar vacío). Las reglas impiden crearlo desde la web.
3. **Desplegar las reglas:**
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use pachoncito-pedidos
   firebase deploy --only firestore:rules
   ```

## Pruebas sin SMS reales

No hay ningún atajo que salte la autenticación en el navegador: Firestore exige un teléfono verificado por Firebase,
así que se usan los mecanismos oficiales, que dan sesiones reales sin enviar SMS. Las reglas son las mismas en local y en producción.

**Teléfonos de prueba** (definidos en `env.js` y en `firestore.rules`): `+34 600 000 000` a `+34 600 000 006` y `+34 600 023 456`.

### Reseñas sin SMS (no necesita configurar nada en Firebase)
En `resenas.html`, si escribes un teléfono de prueba no se llama ni a reCAPTCHA ni a Firebase Auth: aparece el código
`123456` ya rellenado y se abre una sesión de prueba. Las reglas solo aceptan esas reseñas si:
* el teléfono es de prueba y tiene una compra entregada (genera antes los datos de prueba en el panel),
* es la primera de ese teléfono para ese producto (id `test_<teléfono>_<producto>`),
* va marcada como `test: true` (el público no la ve; sí con `?pruebas=1` y en el panel).

Con `?pruebas=1`, un teléfono que no sea de prueba muestra un aviso en lugar de enviar un SMS real.

### Opción A: Firebase real (local o GitHub Pages)
1. Firebase Console → *Authentication → Sign-in method → Teléfono → Números de teléfono para pruebas*:
   añade los 7 números con el código `123456`.
2. En producción, añade `?pruebas=1` a la URL para ver el aviso, el código rellenado automáticamente y las reseñas de prueba.
   Se apaga con `?pruebas=0`. En `localhost` el modo pruebas está siempre activo.

### Opción B: emuladores locales (no tocan la base de datos real)
Requiere Java 11+ y `firebase-tools`.
```bash
firebase emulators:start          # Auth :9099, Firestore :8080, interfaz web :4000
python -m http.server 5500        # en otra terminal, desde la carpeta del proyecto
```
Abre `http://localhost:5500/?emuladores=1`. Con emuladores **cualquier** teléfono funciona y el código se rellena solo.
El emulador empieza vacío: crea el usuario del obrador y el documento `admins/{UID}` desde la interfaz web (`http://127.0.0.1:4000`).

### Generador de datos de prueba
En el panel, sección **🧪 Datos de prueba** (abajo del todo):
* **Generar / regenerar:** crea 7 pedidos en todos los estados, 4 clientes con compras y 2 reseñas de prueba. Pasa por las mismas reglas y la misma lógica de entrega que los pedidos reales.
  * Bruno vino recomendado por Ana: entregado, así que Ana tiene +1 ñapa acumulada en su pedido pendiente.
  * Carla vino recomendada por Bruno: en preparación; al entregarlo, Bruno gana su ñapa.
  * Elena puso como código a Fran, que no es cliente: al entregarlo no premia a nadie.
* **Borrar:** elimina solo los pedidos, clientes y reseñas de los teléfonos de prueba.
* Para probar las reseñas: entra como Bruno (`600 000 002`). Puede valorar el clásico, y el bocadillo se rechaza porque no lo ha comprado.

Las reseñas de cuentas de prueba llevan `test: true`. Las reglas lo exigen, así que no pueden hacerse pasar por clientes reales, y no se muestran al público fuera del modo pruebas.

## Cómo funcionan las ñapas

* **Por volumen:** 1 ñapa por cada 10 € del pedido (envío incluido).
* **Por referido:** al marcar como *Entregado* el primer pedido de un cliente que puso un código de referido (el teléfono de otro cliente con compras), el recomendador acumula 1 ñapa.
* **Por feedback:** desde el panel se puede premiar la primera reseña de cada cliente con 1 ñapa.
* Las ñapas acumuladas aparecen en el siguiente pedido del cliente en el panel y se canjean al entregarlo.

## Enlaces de Interes

* [Instagram Oficial](https://www.instagram.com/pachoncito_oficial)

## Inicio del Proyecto

El desarrollo activo del proyecto dio comienzo el 1 de octubre de 2026.