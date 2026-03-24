// ─── Pleaseme Service Worker ─────────────────────────────────────────
// Versión: actualizar este número cuando se despliega código nuevo
const VER         = 'v4';
const SHELL_CACHE = `pleaseme-shell-${VER}`;
const IMG_CACHE   = `pleaseme-images-${VER}`;

// Archivos del app shell que se pre-cachean al instalar el SW
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './pleaseme.png'
];

// ─── INSTALL: pre-cachear el app shell ───────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())   // activar nuevo SW sin esperar
  );
});

// ─── ACTIVATE: limpiar cachés viejas ─────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('pleaseme-') && k !== SHELL_CACHE && k !== IMG_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())   // tomar control de todas las pestañas abiertas
  );
});

// ─── FETCH: lógica de enrutamiento ───────────────────────────────────
self.addEventListener('fetch', e => {
  // Solo interceptar GET
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // ── Supabase API (datos) → Network-Only ──────────────────────────
  // Los datos del catálogo siempre deben ser frescos
  if (url.hostname.includes('supabase.co') && !url.pathname.includes('/storage/v1/object')) {
    return; // el navegador lo maneja normalmente
  }

  // ── Imágenes → Cache-First ────────────────────────────────────────
  // Supabase Storage, Cloudinary, o cualquier imagen
  const isImage = url.pathname.includes('/storage/v1/object')
    || url.hostname.includes('cloudinary.com')
    || e.request.destination === 'image';

  if (isImage) {
    e.respondWith(
      caches.open(IMG_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          if (cached) return cached;
          return fetch(e.request).then(res => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          }).catch(() => cached); // offline: devolver caché si existe
        })
      )
    );
    return;
  }

  // ── App shell (HTML, manifest, icono) → Stale-While-Revalidate ───
  // Servir al instante desde caché, actualizar en segundo plano
  e.respondWith(
    caches.open(SHELL_CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const networkFetch = fetch(e.request).then(res => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    )
  );
});
