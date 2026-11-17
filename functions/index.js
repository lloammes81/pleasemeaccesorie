// WhatsApp de la tienda (WhatsApp Cloud API de Meta) — dos funciones:
//
// 1. whatsappWebhook: Meta le reenvía cada mensaje que llega al número de la tienda.
//    - Guarda la conversación en Firestore (wa_chats/{número}/mensajes) para la
//      bandeja de chats del admin.
//    - Verificación del teléfono: si el mensaje trae el código de 6 dígitos de un
//      registro del catálogo y viene del MISMO teléfono, marca verificado: true.
// 2. whatsappAdmin: la usa el admin (bandeja de chats). Lista conversaciones, lee
//    mensajes y envía respuestas. Solo responde con la clave de administrador.
//
// Responder dentro de las 24 h del último mensaje de la clienta no tiene costo.
// Ver functions/LEEME.md para configurarlo.

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const WHATSAPP_TOKEN = defineSecret('WHATSAPP_TOKEN');               // token permanente de la app de Meta
const WHATSAPP_VERIFY_TOKEN = defineSecret('WHATSAPP_VERIFY_TOKEN'); // palabra secreta que tú inventas (alta del webhook)
const WHATSAPP_APP_SECRET = defineSecret('WHATSAPP_APP_SECRET');     // «App secret» de la app de Meta
const WHATSAPP_PHONE_ID = defineSecret('WHATSAPP_PHONE_ID');         // «Phone number ID» del número de la tienda
const WHATSAPP_ADMIN_KEY = defineSecret('WHATSAPP_ADMIN_KEY');       // clave que el admin escribe en Configuración

const GRAPH = 'https://graph.facebook.com/v21.0';
const tel10 = t => String(t || '').replace(/\D/g, '').slice(-10);
const igual = (a, b) => { a = Buffer.from(String(a || '')); b = Buffer.from(String(b || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); };

// Comprueba que el aviso viene de Meta (firma X-Hub-Signature-256)
function firmaValida(req, secreto) {
  const esperada = 'sha256=' + crypto.createHmac('sha256', secreto).update(req.rawBody || '').digest('hex');
  return igual(req.get('x-hub-signature-256'), esperada);
}

// Envía un texto por WhatsApp y lo guarda en la conversación. Devuelve { ok, id, error }.
async function enviarTexto(para, texto, phoneId) {
  const r = await fetch(`${GRAPH}/${phoneId || WHATSAPP_PHONE_ID.value()}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN.value(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = d.error || {};
    // 131047: pasaron más de 24 h desde su último mensaje (hace falta una plantilla aprobada)
    return { ok: false, error: e.code === 131047 ? 'fuera_de_24h' : (e.message || 'Error ' + r.status) };
  }
  const id = d.messages && d.messages[0] && d.messages[0].id;
  const chat = db.collection('wa_chats').doc(String(para));
  const msgs = chat.collection('mensajes');
  await (id ? msgs.doc(id) : msgs.doc()).set({ de: 'tienda', texto, at: FV.serverTimestamp(), estado: 'enviado' });
  await chat.set({ telefono: String(para), ultimo_texto: texto, ultimo_de: 'tienda', ultimo_at: FV.serverTimestamp() }, { merge: true });
  return { ok: true, id };
}

// Texto legible de cualquier tipo de mensaje
function textoDe(m) {
  if (m.type === 'text') return (m.text && m.text.body) || '';
  if (m.type === 'image') return '📷 Foto' + (m.image && m.image.caption ? ': ' + m.image.caption : '');
  if (m.type === 'video') return '🎥 Video' + (m.video && m.video.caption ? ': ' + m.video.caption : '');
  if (m.type === 'audio') return '🎤 Nota de voz';
  if (m.type === 'document') return '📄 Documento' + (m.document && m.document.filename ? ': ' + m.document.filename : '');
  if (m.type === 'sticker') return '💟 Sticker';
  if (m.type === 'location') return '📍 Ubicación';
  if (m.type === 'button') return (m.button && m.button.text) || '';
  if (m.type === 'interactive') { const i = m.interactive || {}; return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || ''; }
  return '(' + m.type + ')';
}

// Guarda el mensaje recibido en la bandeja
async function guardarRecibido(m, nombrePerfil) {
  const chat = db.collection('wa_chats').doc(String(m.from));
  const texto = textoDe(m);
  const at = m.timestamp ? admin.firestore.Timestamp.fromMillis(Number(m.timestamp) * 1000) : FV.serverTimestamp();
  await chat.collection('mensajes').doc(m.id).set({ de: 'cliente', texto, tipo: m.type, at }, { merge: true });
  await chat.set({
    telefono: String(m.from), ...(nombrePerfil ? { nombre: nombrePerfil } : {}), ultimo_texto: texto, ultimo_de: 'cliente',
    ultimo_at: at, ultimo_cliente_at: at, no_leidos: FV.increment(1),
  }, { merge: true });
  return texto;
}

// Verificación del teléfono con el código del catálogo
async function verificar(m, texto, phoneNumberId) {
  const codigo = (texto.match(/\b(\d{6})\b/) || [])[1];
  if (!codigo) return;
  const snap = await db.collection('clientes_catalogo').where('verificacion.codigo', '==', codigo).limit(5).get();
  if (snap.empty) return;   // un número de 6 cifras cualquiera: es un mensaje normal
  const doc = snap.docs.find(d => tel10(d.data().telefono || d.id) === tel10(m.from));
  if (!doc) {
    await enviarTexto(m.from, 'No encontramos un registro con ese código para este número. Revisa que te registraste con este mismo WhatsApp en el catálogo de Pleaseme.', phoneNumberId);
    return;
  }
  if (doc.data().verificado === true) { await enviarTexto(m.from, '✅ Tu número ya estaba verificado. ¡Gracias!', phoneNumberId); return; }
  await doc.ref.set({ verificado: true, verificado_at: FV.serverTimestamp(), verificado_whatsapp: m.from, verificacion: FV.delete() }, { merge: true });
  const nombre = String(doc.data().nombre || '').split(' ')[0];
  await enviarTexto(m.from, `✅ ¡Listo${nombre ? ', ' + nombre : ''}! Tu número quedó verificado en Pleaseme Accessories.`, phoneNumberId);
}

exports.whatsappWebhook = onRequest(
  { secrets: [WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_PHONE_ID], region: 'us-central1' },
  async (req, res) => {
    // Alta del webhook en Meta (GET con hub.challenge)
    if (req.method === 'GET') {
      if (req.query['hub.mode'] === 'subscribe' && igual(req.query['hub.verify_token'], WHATSAPP_VERIFY_TOKEN.value())) {
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
          const nombres = {};
          (v.contacts || []).forEach(c => { nombres[c.wa_id] = c.profile && c.profile.name; });
          for (const m of v.messages || []) {
            const texto = await guardarRecibido(m, nombres[m.from]);
            if (m.type === 'text') await verificar(m, texto, phoneNumberId);
          }
          // Estado de lo que envió la tienda: enviado → entregado → leído
          for (const st of v.statuses || []) {
            await db.collection('wa_chats').doc(String(st.recipient_id)).collection('mensajes').doc(st.id)
              .set({ estado: st.status }, { merge: true }).catch(() => {});
          }
        }
      }
    } catch (e) { console.error('Error procesando el webhook:', e); }
    res.sendStatus(200);   // Meta solo necesita saber que llegó
  }
);

// Bandeja de chats del admin. POST { accion: 'chats' | 'mensajes' | 'enviar', ... } con el
// encabezado x-admin-key. Los chats no se leen desde el navegador directamente, así no
// quedan expuestos a nadie más.
const ORIGENES = ['https://pleasemecatalogo.com', 'https://www.pleasemecatalogo.com', 'http://localhost:8765'];
exports.whatsappAdmin = onRequest(
  { secrets: [WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_ADMIN_KEY], region: 'us-central1' },
  async (req, res) => {
    const origen = req.get('origin') || '';
    if (ORIGENES.includes(origen) || /^https:\/\/[a-z0-9-]+\.github\.io$/.test(origen)) res.set('Access-Control-Allow-Origin', origen);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'content-type, x-admin-key');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST') return res.sendStatus(405);
    if (!igual(req.get('x-admin-key'), WHATSAPP_ADMIN_KEY.value())) return res.status(401).json({ error: 'clave' });

    const b = req.body || {};
    const ms = t => (t && t.toMillis ? t.toMillis() : null);
    try {
      if (b.accion === 'chats') {
        const snap = await db.collection('wa_chats').orderBy('ultimo_at', 'desc').limit(150).get();
        return res.json({ chats: snap.docs.map(d => {
          const x = d.data();
          return { id: d.id, telefono: x.telefono || d.id, nombre: x.nombre || '', ultimo_texto: x.ultimo_texto || '', ultimo_de: x.ultimo_de || '',
                   ultimo_at: ms(x.ultimo_at), ultimo_cliente_at: ms(x.ultimo_cliente_at), no_leidos: x.no_leidos || 0 };
        }) });
      }
      if (b.accion === 'mensajes') {
        const chat = db.collection('wa_chats').doc(String(b.chat));
        const snap = await chat.collection('mensajes').orderBy('at', 'desc').limit(Math.min(Number(b.limite) || 80, 300)).get();
        if (b.marcarLeido !== false) await chat.set({ no_leidos: 0 }, { merge: true });
        return res.json({ mensajes: snap.docs.map(d => ({ id: d.id, ...d.data(), at: ms(d.data().at) })).reverse() });
      }
      if (b.accion === 'enviar') {
        const texto = String(b.texto || '').trim();
        const para = String(b.chat || '').replace(/\D/g, '');
        if (!texto || para.length < 10) return res.status(400).json({ error: 'datos' });
        return res.json(await enviarTexto(para, texto.slice(0, 4096)));
      }
      return res.status(400).json({ error: 'accion' });
    } catch (e) {
      console.error('whatsappAdmin:', e);
      return res.status(500).json({ error: e.message });
    }
  }
);

// Pedido enviado desde el carrito sin abrir WhatsApp (clientas que ya tienen pedidos en su
// dispositivo). POST { pedido: '<id del documento en pedidos>' }. El texto se arma aquí con
// los datos guardados en Firestore, así nadie puede usar la función para mandar otra cosa:
// solo sirve para un pedido recién hecho (10 min), una sola vez, al teléfono de su registro.
// Llega al WhatsApp de la clienta desde el número de la tienda y queda en la bandeja del admin.
const PLANTILLA_PEDIDO = 'pedido_recibido';   // plantilla aprobada en Meta para cuando pasaron más de 24 h
const dinero = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
function textoPedido(p) {
  const env = p.envio || {};
  const nombre = String(env.nombre || '').split(' ')[0];
  let t = `📋 *Pedido ${p.numero}*\n\n¡Hola${nombre ? ' ' + nombre : ''}! Recibimos tu pedido en Pleaseme Accessories 💛\n`;
  (p.items || []).forEach(it => {
    t += `\n• ${it.qty} × ${it.name}` + (it.variante ? ` (${it.variante})` : '') + (it.medida ? ` — ${it.medida}` : '') + ` — ${dinero(it.price * it.qty)}`;
  });
  if (p.descuento) t += `\n\nSubtotal: ${dinero(p.subtotal)}\nDescuento: ${p.descuento}%`;
  t += `\n\n*Total: ${dinero(p.total_final)}*`;
  if (p.nota) t += `\n\n📝 ${p.nota}`;
  if (env.direccion) t += `\n\n🏠 ${env.direccion}`;
  t += '\n\nTe escribiremos por aquí para confirmar. ¡Gracias por elegirnos!';
  return t.slice(0, 4096);
}
async function enviarPlantillaPedido(para, p) {
  const nombre = String((p.envio || {}).nombre || '').split(' ')[0] || 'cliente';
  const r = await fetch(`${GRAPH}/${WHATSAPP_PHONE_ID.value()}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN.value(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'template', template: {
      name: PLANTILLA_PEDIDO, language: { code: 'es' },
      components: [{ type: 'body', parameters: [nombre, p.numero, dinero(p.total_final)].map(text => ({ type: 'text', text })) }],
    } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: (d.error && d.error.message) || 'Error ' + r.status };
  const texto = `📋 Pedido ${p.numero} recibido — Total ${dinero(p.total_final)} (plantilla)`;
  const chat = db.collection('wa_chats').doc(para);
  const id = d.messages && d.messages[0] && d.messages[0].id;
  await (id ? chat.collection('mensajes').doc(id) : chat.collection('mensajes').doc()).set({ de: 'tienda', texto, at: FV.serverTimestamp(), estado: 'enviado' });
  await chat.set({ telefono: para, ultimo_texto: texto, ultimo_de: 'tienda', ultimo_at: FV.serverTimestamp() }, { merge: true });
  return { ok: true, id };
}
exports.pedidoWhatsApp = onRequest(
  { secrets: [WHATSAPP_TOKEN, WHATSAPP_PHONE_ID], region: 'us-central1' },
  async (req, res) => {
    const origen = req.get('origin') || '';
    if (ORIGENES.includes(origen) || /^https:\/\/[a-z0-9-]+\.github\.io$/.test(origen)) res.set('Access-Control-Allow-Origin', origen);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'content-type');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    if (req.method !== 'POST') return res.sendStatus(405);

    const id = String((req.body || {}).pedido || '');
    if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return res.status(400).json({ ok: false, error: 'datos' });
    const ref = db.collection('pedidos').doc(id);
    try {
      // Se marca dentro de una transacción para que el mismo pedido no se envíe dos veces
      const p = await db.runTransaction(async tx => {
        const s = await tx.get(ref);
        if (!s.exists) return null;
        const x = s.data();
        const hace = x.fecha && x.fecha.toMillis ? Date.now() - x.fecha.toMillis() : Infinity;
        if (x.wa_auto || hace > 10 * 60 * 1000) return null;
        tx.update(ref, { wa_auto: 'enviando' });
        return x;
      });
      if (!p) return res.status(409).json({ ok: false, error: 'pedido' });
      const tel = tel10(p.envio && p.envio.telefono);
      if (tel.length !== 10) { await ref.update({ wa_auto: FV.delete() }); return res.status(400).json({ ok: false, error: 'telefono' }); }
      const para = '1' + tel;   // EE. UU. y República Dominicana usan el código +1

      let r = await enviarTexto(para, textoPedido(p));
      if (!r.ok && r.error === 'fuera_de_24h') r = await enviarPlantillaPedido(para, p);
      if (r.ok && p.img_url) {
        await fetch(`${GRAPH}/${WHATSAPP_PHONE_ID.value()}/messages`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN.value(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'image', image: { link: p.img_url, caption: 'Pedido ' + p.numero } }),
        }).catch(() => {});
      }
      await ref.update(r.ok ? { wa_auto: 'enviado', wa_auto_at: FV.serverTimestamp() } : { wa_auto: FV.delete() });
      return res.json({ ok: r.ok, error: r.error });
    } catch (e) {
      console.error('pedidoWhatsApp:', e);
      await ref.update({ wa_auto: FV.delete() }).catch(() => {});
      return res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// ─── Aviso de cada pedido nuevo al WhatsApp personal de la administradora ───
// Se activa sola cuando se crea un documento en «pedidos». Le llega desde el número de la
// tienda: el resumen del pedido, la imagen del pedido y la foto de cada producto. El número
// se guarda en el admin (Configuración → «Pedidos nuevos a mi WhatsApp»).
// WhatsApp solo deja mandar texto y fotos libres si ella escribió al número de la tienda en
// las últimas 24 h; si no, se envía la plantilla «aviso_pedido» (con la imagen del pedido)
// y, en cuanto ella responda cualquier cosa, los siguientes pedidos llegan completos.
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const PLANTILLA_AVISO = 'aviso_pedido';
const LOGO_URL = 'https://pleasemecatalogo.com/logo.png';

async function llamarMeta(para, cuerpo) {
  const r = await fetch(`${GRAPH}/${WHATSAPP_PHONE_ID.value()}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WHATSAPP_TOKEN.value(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, ...cuerpo }),
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true };
  const e = d.error || {};
  return { ok: false, error: e.code === 131047 ? 'fuera_de_24h' : (e.message || 'Error ' + r.status) };
}

function textoAviso(p) {
  const env = p.envio || {};
  let t = `🛍️ *Nuevo pedido ${p.numero}*\n`;
  if (env.nombre) t += `\n👤 ${env.nombre}`;
  if (env.telefono) t += `\n📱 ${env.telefono}`;
  if (env.direccion) t += `\n🏠 ${env.direccion}`;
  const ciudad = [env.ciudad, env.estado, env.zip].filter(Boolean).join(', ');
  if (ciudad) t += `\n📍 ${ciudad}`;
  if (env.pais) t += `\n🌎 ${env.pais === 'RD' ? 'República Dominicana' : 'USA'}`;
  if (!env.nombre) t += '\n👤 Cliente sin registro';
  t += '\n';
  (p.items || []).forEach(it => {
    t += `\n• ${it.qty} × ${it.name}` + (it.variante ? ` (${it.variante})` : '') + (it.medida ? ` — ${it.medida}` : '') + ` — ${dinero(it.price * it.qty)}`;
  });
  if (p.descuento) t += `\n\nSubtotal: ${dinero(p.subtotal)}\nDescuento: ${p.descuento}%`;
  t += `\n\n*Total: ${dinero(p.total_final)}*`;
  if (p.nota) t += `\n\n📝 ${p.nota}`;
  return t.slice(0, 4096);
}

exports.avisoPedidoWhatsApp = onDocumentCreated(
  { document: 'pedidos/{id}', secrets: [WHATSAPP_TOKEN, WHATSAPP_PHONE_ID], region: 'us-central1' },
  async event => {
    const p = event.data && event.data.data();
    if (!p) return;
    const cfg = await db.collection('config').doc('pm_whatsapp_aviso_pedidos').get();
    const para = String((cfg.exists && cfg.data().value && cfg.data().value.numero) || '').replace(/\D/g, '');
    if (para.length < 11) return;   // aviso apagado
    const esUrl = u => typeof u === 'string' && /^https:\/\//.test(u);

    let r = await llamarMeta(para, { type: 'text', text: { body: textoAviso(p) } });
    if (!r.ok && r.error === 'fuera_de_24h') {
      const env = p.envio || {};
      r = await llamarMeta(para, { type: 'template', template: {
        name: PLANTILLA_AVISO, language: { code: 'es' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { link: esUrl(p.img_url) ? p.img_url : LOGO_URL } }] },
          { type: 'body', parameters: [p.numero, env.nombre || 'Cliente sin registro', dinero(p.total_final)].map(text => ({ type: 'text', text: String(text) })) },
        ],
      } });
      if (!r.ok) console.error('avisoPedidoWhatsApp (plantilla):', r.error);
      await event.data.ref.update({ wa_aviso: r.ok ? 'plantilla' : 'error' }).catch(() => {});
      return;   // fuera de las 24 h no se pueden mandar las fotos sueltas
    }
    if (!r.ok) { console.error('avisoPedidoWhatsApp:', r.error); await event.data.ref.update({ wa_aviso: 'error' }).catch(() => {}); return; }

    // Imagen del pedido y foto de cada producto, en orden
    if (esUrl(p.img_url)) await llamarMeta(para, { type: 'image', image: { link: p.img_url, caption: 'Pedido ' + p.numero } });
    for (const it of (p.items || []).slice(0, 30)) {
      if (!esUrl(it.photo)) continue;
      const caption = `${it.qty} × ${it.name}` + (it.variante ? ` (${it.variante})` : '') + (it.medida ? ` — ${it.medida}` : '') + ` — ${dinero(it.price * it.qty)}`;
      await llamarMeta(para, { type: 'image', image: { link: it.photo, caption: caption.slice(0, 1024) } });
    }
    await event.data.ref.update({ wa_aviso: 'enviado' }).catch(() => {});
  }
);
