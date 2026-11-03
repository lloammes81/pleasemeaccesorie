// Verificación del teléfono por WhatsApp (WhatsApp Cloud API de Meta).
//
// 1. Al registrarse en el catálogo, la clienta recibe un código de 6 dígitos
//    (clientes_catalogo/{tel-…}.verificacion.codigo) y lo envía desde su WhatsApp
//    al número de verificación de la tienda.
// 2. Meta reenvía ese mensaje a esta función (webhook). Si el código existe y el
//    mensaje viene del MISMO teléfono con el que se registró, se marca
//    verificado: true y se le responde por WhatsApp.
//
// Responder dentro de las 24 h de un mensaje que escribe la clienta no tiene costo
// en WhatsApp (conversación de servicio). Ver functions/LEEME.md para configurarlo.

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const WHATSAPP_TOKEN = defineSecret('WHATSAPP_TOKEN');            // token permanente de la app de Meta
const WHATSAPP_VERIFY_TOKEN = defineSecret('WHATSAPP_VERIFY_TOKEN'); // palabra secreta que tú inventas
const WHATSAPP_APP_SECRET = defineSecret('WHATSAPP_APP_SECRET');   // «App secret» de la app de Meta

const tel10 = t => String(t || '').replace(/\D/g, '').slice(-10);

// Comprueba que el aviso viene de Meta (firma X-Hub-Signature-256)
function firmaValida(req, secreto) {
  const firma = req.get('x-hub-signature-256') || '';
  const esperada = 'sha256=' + crypto.createHmac('sha256', secreto).update(req.rawBody || '').digest('hex');
  return firma.length === esperada.length && crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
}

async function responder(phoneNumberId, para, texto) {
  try {
    await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN.value(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto } }),
    });
  } catch (e) { console.error('No se pudo responder por WhatsApp:', e.message); }
}

async function verificar(mensaje, phoneNumberId) {
  const desde = mensaje.from;                                   // número de WhatsApp de quien escribe
  const texto = (mensaje.text && mensaje.text.body) || '';
  const codigo = (texto.match(/\b(\d{6})\b/) || [])[1];
  if (!codigo) return;

  const snap = await db.collection('clientes_catalogo').where('verificacion.codigo', '==', codigo).limit(5).get();
  const doc = snap.docs.find(d => tel10(d.data().telefono || d.id) === tel10(desde));
  if (!doc) {
    await responder(phoneNumberId, desde,
      'No encontramos un registro con ese código para este número. Revisa que te registraste con este mismo WhatsApp en el catálogo de Pleaseme.');
    return;
  }
  if (doc.data().verificado === true) {
    await responder(phoneNumberId, desde, '✅ Tu número ya estaba verificado. ¡Gracias!');
    return;
  }
  await doc.ref.set({
    verificado: true,
    verificado_at: admin.firestore.FieldValue.serverTimestamp(),
    verificado_whatsapp: desde,
    verificacion: admin.firestore.FieldValue.delete(),
  }, { merge: true });
  const nombre = String(doc.data().nombre || '').split(' ')[0];
  await responder(phoneNumberId, desde, `✅ ¡Listo${nombre ? ', ' + nombre : ''}! Tu número quedó verificado en Pleaseme Accessories.`);
}

exports.whatsappWebhook = onRequest(
  { secrets: [WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET], region: 'us-central1' },
  async (req, res) => {
    // Paso de alta del webhook en Meta (GET con hub.challenge)
    if (req.method === 'GET') {
      if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WHATSAPP_VERIFY_TOKEN.value()) {
        return res.status(200).send(req.query['hub.challenge']);
      }
      return res.sendStatus(403);
    }
    if (req.method !== 'POST') return res.sendStatus(405);
    if (!firmaValida(req, WHATSAPP_APP_SECRET.value())) return res.sendStatus(401);

    try {
      for (const entry of req.body.entry || []) {
        for (const change of entry.changes || []) {
          const v = change.value || {};
          const phoneNumberId = v.metadata && v.metadata.phone_number_id;
          for (const m of v.messages || []) {
            if (m.type === 'text') await verificar(m, phoneNumberId);
          }
        }
      }
    } catch (e) { console.error('Error procesando el webhook:', e); }
    res.sendStatus(200);   // Meta solo necesita saber que llegó
  }
);
