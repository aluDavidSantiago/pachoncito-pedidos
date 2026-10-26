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
| `firebase.js` | Configuración única de Firebase |
| `shared.js` | Precios, regla de ñapas y utilidades comunes |
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

## Cómo funcionan las ñapas

* **Por volumen:** 1 ñapa por cada 10 € del pedido (envío incluido).
* **Por referido:** al marcar como *Entregado* el primer pedido de un cliente que puso un código de referido (el teléfono de otro cliente con compras), el recomendador acumula 1 ñapa.
* **Por feedback:** desde el panel se puede premiar la primera reseña de cada cliente con 1 ñapa.
* Las ñapas acumuladas aparecen en el siguiente pedido del cliente en el panel y se canjean al entregarlo.

## Enlaces de Interes

* [Instagram Oficial](https://www.instagram.com/pachoncito_oficial)

## Inicio del Proyecto

El desarrollo activo del proyecto dio comienzo el 1 de octubre de 2026.