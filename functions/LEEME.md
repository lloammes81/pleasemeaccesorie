# WhatsApp de la tienda: bandeja de chats y verificación del teléfono

Con la WhatsApp Cloud API de Meta, el número de la tienda queda conectado a dos funciones:

- **whatsappAdmin** — la **bandeja de chats dentro del admin** (el icono verde abajo a la
  derecha): lista de conversaciones, mensajes y caja para responder.
- **whatsappWebhook** — recibe cada mensaje que llega al número, lo guarda para la bandeja y,
  si trae el código de 6 dígitos de un registro, verifica el teléfono de esa clienta.

## Verificación del teléfono

Cuando una clienta se registra en el catálogo recibe un código de 6 dígitos. Lo envía
desde su WhatsApp al **número de verificación** de la tienda; esta función lo recibe,
comprueba que el mensaje viene del mismo teléfono con el que se registró y la marca
como **verificada** en `clientes_catalogo`. El catálogo lo detecta al instante.

## Lo que necesitas (una sola vez)

1. **Firebase en plan Blaze.** Las funciones de Firebase solo corren en Blaze. Con este
   volumen queda dentro de lo gratis; pon una alerta de presupuesto (por ejemplo $1) en
   Google Cloud → Facturación → Presupuestos y alertas.
2. **Un número de WhatsApp aparte para verificar.** El número que uses en la WhatsApp
   Cloud API no puede estar a la vez en la app de WhatsApp de un teléfono.
3. **Una app de WhatsApp en Meta:**
   - Entra en <https://developers.facebook.com/apps> → *Crear app* → tipo **Empresa** →
     agrega el producto **WhatsApp**.
   - En *WhatsApp → Configuración de la API* registra tu número y anota el
     **Phone number ID** (identificador del número).
   - En *Configuración de la app → Básica* copia la **Clave secreta de la app** (App secret).
   - Crea un **token permanente**: Business Settings → Usuarios del sistema → *Agregar*
     (rol Administrador) → *Generar token* con los permisos `whatsapp_business_messaging`
     y `whatsapp_business_management`.

## Publicar la función

En una computadora con Node.js 20:

```bash
npm install -g firebase-tools
```

```bash
firebase login
```

Desde la carpeta del repositorio:

```bash
cd functions && npm install && cd ..
```

```bash
firebase functions:secrets:set WHATSAPP_TOKEN
```

```bash
firebase functions:secrets:set WHATSAPP_APP_SECRET
```

```bash
firebase functions:secrets:set WHATSAPP_VERIFY_TOKEN
```

(En `WHATSAPP_VERIFY_TOKEN` escribe una palabra secreta que inventes; la usarás en el paso siguiente.)

```bash
firebase functions:secrets:set WHATSAPP_PHONE_ID
```

(El **Phone number ID** del número de la tienda.)

```bash
firebase functions:secrets:set WHATSAPP_ADMIN_KEY
```

(Una clave larga que inventes, por ejemplo de 20 letras y números. Es la que escribirás en el
admin para abrir la bandeja; quien no la tenga no puede leer ni enviar mensajes.)

```bash
firebase deploy --only functions
```

Al terminar muestra la dirección de la función, parecida a
`https://us-central1-pleasemecatalogo.cloudfunctions.net/whatsappWebhook`.

## Conectar Meta con la función

En Meta → *WhatsApp → Configuración* → **Webhook** → *Editar*:

- **URL de devolución de llamada:** la dirección de la función.
- **Token de verificación:** la palabra secreta de `WHATSAPP_VERIFY_TOKEN`.
- Después, en *Campos del webhook*, suscríbete a **messages**.

## Bandeja de chats en el admin

En **Admin → Configuración → Bandeja de chats de WhatsApp**:

- **Dirección de la función:** déjala vacía si es
  `https://us-central1-pleasemecatalogo.cloudfunctions.net/whatsappAdmin` (la que muestra
  `firebase deploy`); si es otra, cópiala aquí.
- **Clave de administrador:** la misma de `WHATSAPP_ADMIN_KEY`. Se guarda solo en ese
  dispositivo (hay que escribirla una vez en cada computadora o teléfono).

Pulsa **Probar conexión**. Desde ese momento el icono verde abre los chats dentro del admin y
muestra en rojo cuántos mensajes sin leer hay.

**Regla de WhatsApp:** se puede responder con texto libre hasta 24 horas después del último
mensaje de la clienta. Pasado ese tiempo, WhatsApp solo deja escribirle con una plantilla
aprobada por Meta; la bandeja lo avisa. Los chats son con el número conectado a la API, no con
el WhatsApp personal del teléfono.

## Activar la verificación en el catálogo

En **Admin → Configuración → Verificación por WhatsApp** escribe el número de
verificación (con código de país, por ejemplo `18095551234`) y guarda. Desde ese
momento:

- Al registrarse, la clienta ve el botón **«Enviar código por WhatsApp»**.
- En Admin → Clientes aparece **✔ Verificada** o **⏳ Sin verificar**.
- En el historial del catálogo, las facturas solo se muestran a quien verificó su número.

Si dejas el número vacío, la verificación queda apagada y el catálogo funciona como antes.

## Recomendado: proteger los chats

Los chats solo los lee la función. En Firebase → Firestore → **Reglas** añade:

```
match /wa_chats/{chat=**} {
  allow read, write: if false;
}
```

## Recomendado: que nadie pueda marcarse «verificada» ni quitarse un bloqueo a mano

En Firebase → Firestore → **Reglas**, dentro de la regla de `clientes_catalogo`, añade
esta condición a las escrituras para que solo la función pueda cambiar esos campos:

```
!request.resource.data.diff(resource == null ? {} : resource.data).affectedKeys()
  .hasAny(['verificado', 'verificado_at', 'verificado_whatsapp', 'bloqueado', 'bloqueado_at'])
```

## Pedido enviado solo desde el carrito (pedidoWhatsApp)

Si la clienta **ya hizo pedidos antes en su dispositivo** y está **registrada** (con su
teléfono), al tocar «Enviar por WhatsApp» el pedido se guarda y la función **pedidoWhatsApp**
se lo envía desde el número de la tienda a su WhatsApp, **sin abrirle WhatsApp**. El mensaje
queda también en la bandeja de chats del admin. Si algo falla, el catálogo vuelve a mostrar el
botón de siempre para abrir WhatsApp.

WhatsApp solo deja mandar texto libre si la clienta escribió al número en las últimas 24 h.
Para las demás, crea en Meta (WhatsApp → Plantillas de mensajes) una plantilla de categoría
**Utilidad**, idioma **Español (es)**, llamada `pedido_recibido`, con este cuerpo:

> Hola {{1}}, recibimos tu pedido {{2}} por un total de {{3}} en Pleaseme Accessories. Te escribiremos por aquí para confirmarlo. ¡Gracias!

Usa los mismos secretos que las otras funciones; se publica con el mismo
`firebase deploy --only functions`.

## Pedidos nuevos a tu WhatsApp personal (avisoPedidoWhatsApp)

Cada pedido que entra al catálogo te llega a tu WhatsApp personal desde el número de la tienda:
el resumen (clienta, teléfono, dirección, productos, total y nota), la imagen del pedido y la
foto de cada producto con su cantidad y precio.

1. En el admin → Configuración → **Pedidos nuevos a mi WhatsApp**, escribe tu número personal
   con código de país (tiene que ser distinto del número de la tienda) y toca Guardar.
2. Crea en Meta (WhatsApp → Plantillas de mensajes) una plantilla de categoría **Utilidad**,
   idioma **Español (es)**, llamada `aviso_pedido`, con encabezado de tipo **Imagen** y este cuerpo:

   > Nuevo pedido {{1}} de {{2}} por {{3}}. Responde a este mensaje para recibir el detalle y las fotos de los siguientes pedidos.

3. `firebase deploy --only functions`

WhatsApp solo deja mandar texto y fotos libres si escribiste al número de la tienda en las
últimas 24 h. Si no, te llega la plantilla (con la imagen del pedido); respóndele cualquier
cosa y los pedidos de las siguientes 24 h te llegan completos, con todas las fotos.
