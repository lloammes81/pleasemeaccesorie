// Service worker del catálogo Pleaseme: muestra y retira notificaciones.
// Las notificaciones de novedades llevan data.expira (ms); pasado ese momento se cierran.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(Promise.all([self.clients.claim(), limpiarCaducadas()])));

async function limpiarCaducadas() {
  const ahora = Date.now();
  const lista = await self.registration.getNotifications();
  lista.forEach(n => { if (n.data && n.data.expira && n.data.expira <= ahora) n.close(); });
}

self.addEventListener('message', e => {
  if (e.data && e.data.tipo === 'limpiar-caducadas') e.waitUntil(limpiarCaducadas());
});

// Listo para avisos enviados desde un servidor (Web Push): {title, body, url, expira}
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  const expira = Number(d.expira) || Date.now() + 24 * 60 * 60 * 1000;
  e.waitUntil(limpiarCaducadas().then(() => {
    if (expira <= Date.now()) return;
    return self.registration.showNotification(d.title || '✨ Pleaseme', {
      body: d.body || '', icon: './pleaseme.png', badge: './pleaseme.png',
      tag: d.tag || 'temporada-nuevos', renotify: true, data: { url: d.url || './index.html?abrir=temporada', expira }
    });
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) { if ('focus' in w) { w.navigate(url).catch(() => {}); return w.focus(); } }
    return self.clients.openWindow(url);
  }));
});

// ─── NÚMERO EN EL ICONO DE LA APP ─────────────────────────────────────────────
// La página le pasa los productos que este dispositivo ya conoce (sin contar los que
// faltan por ver). Con la app cerrada:
//  - al llegar un aviso (push), el número sube en 1;
//  - con «periodicsync» (Chrome en Android, app instalada) revisa el catálogo cada pocas
//    horas y muestra cuántas piezas activas no conoce todavía.
// Al abrir la app, la página vuelve a calcular el número exacto.
const BADGE_CACHE = 'pm-badge', BADGE_KEY = './__badge-estado';
const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/pleasemecatalogo/databases/(default)/documents/catalogo_productos';
const API_KEY = 'AIzaSyCqer7Y1lA9ciISWJ7FogszjGgZ8CCpTDg';

async function leerBadge() {
  try { const r = await (await caches.open(BADGE_CACHE)).match(BADGE_KEY); return r ? await r.json() : null; } catch (e) { return null; }
}
async function guardarBadge(estado) {
  try { await (await caches.open(BADGE_CACHE)).put(BADGE_KEY, new Response(JSON.stringify(estado), { headers: { 'Content-Type': 'application/json' } })); } catch (e) {}
}
async function ponerBadge(n) {
  try {
    if (!('setAppBadge' in self.navigator)) return;
    if (n > 0) await self.navigator.setAppBadge(n); else await self.navigator.clearAppBadge();
  } catch (e) {}
}

// Cuenta las piezas activas del catálogo que este dispositivo aún no conoce
async function revisarNovedades() {
  const est = await leerBadge();
  if (!est || !Array.isArray(est.conocidos)) return;
  const conocidos = new Set(est.conocidos);
  let nuevos = 0, token = '';
  do {
    const url = `${FIRESTORE}?pageSize=300&mask.fieldPaths=active&key=${API_KEY}` + (token ? '&pageToken=' + encodeURIComponent(token) : '');
    const r = await fetch(url);
    if (!r.ok) return;
    const d = await r.json();
    (d.documents || []).forEach(doc => {
      const id = doc.name.split('/').pop();
      const inactivo = doc.fields && doc.fields.active && doc.fields.active.booleanValue === false;
      if (!inactivo && !conocidos.has(id)) nuevos++;
    });
    token = d.nextPageToken || '';
  } while (token);
  await guardarBadge({ ...est, pendientes: nuevos });
  await ponerBadge(nuevos);
}

self.addEventListener('message', e => {
  if (e.data && e.data.tipo === 'badge-estado') {
    e.waitUntil(guardarBadge({ conocidos: e.data.conocidos || [], pendientes: Number(e.data.pendientes) || 0 }));
  }
});

self.addEventListener('periodicsync', e => {
  if (e.tag === 'pm-novedades') e.waitUntil(revisarNovedades().catch(() => {}));
});

self.addEventListener('push', e => {
  e.waitUntil(leerBadge().then(est => {
    const n = ((est && est.pendientes) || 0) + 1;
    return guardarBadge({ conocidos: (est && est.conocidos) || [], pendientes: n }).then(() => ponerBadge(n));
  }));
});
