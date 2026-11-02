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
