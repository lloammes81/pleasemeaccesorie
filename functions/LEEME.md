# Verificación del teléfono por WhatsApp

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
firebase deploy --only functions
```

Al terminar muestra la dirección de la función, parecida a
`https://us-central1-pleasemecatalogo.cloudfunctions.net/whatsappWebhook`.

## Conectar Meta con la función

En Meta → *WhatsApp → Configuración* → **Webhook** → *Editar*:

- **URL de devolución de llamada:** la dirección de la función.
- **Token de verificación:** la palabra secreta de `WHATSAPP_VERIFY_TOKEN`.
- Después, en *Campos del webhook*, suscríbete a **messages**.

## Activarla en el catálogo

En **Admin → Configuración → Verificación por WhatsApp** escribe el número de
verificación (con código de país, por ejemplo `18095551234`) y guarda. Desde ese
momento:

- Al registrarse, la clienta ve el botón **«Enviar código por WhatsApp»**.
- En Admin → Clientes aparece **✔ Verificada** o **⏳ Sin verificar**.
- En el historial del catálogo, las facturas solo se muestran a quien verificó su número.

Si dejas el número vacío, la verificación queda apagada y el catálogo funciona como antes.

## Recomendado: que nadie pueda marcarse «verificada» a mano

En Firebase → Firestore → **Reglas**, dentro de la regla de `clientes_catalogo`, añade
esta condición a las escrituras para que solo la función pueda cambiar esos campos:

```
!request.resource.data.diff(resource == null ? {} : resource.data).affectedKeys()
  .hasAny(['verificado', 'verificado_at', 'verificado_whatsapp'])
```
