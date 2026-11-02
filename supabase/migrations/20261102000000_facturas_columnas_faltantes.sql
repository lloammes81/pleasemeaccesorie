-- Columnas y tabla que facturas.html usa y que no existían en Supabase.
-- Sin esto, Supabase responde 400 (PGRST204) al crear/editar facturas y clientes,
-- y 404 (PGRST205) al abrir el historial de impresión.
-- Ejecutar una vez en Supabase → SQL Editor. Es seguro repetirlo.

-- ── facturas ──
alter table public.facturas
  add column if not exists client_street        text,
  add column if not exists client_city          text,
  add column if not exists client_state         text,
  add column if not exists client_zip           text,
  add column if not exists shipping_address_usa text,
  add column if not exists casillero_number     text,
  add column if not exists tracking_number      text,
  add column if not exists tracking_status      text,
  add column if not exists tracking_delivered   boolean default false;

-- ── clientes ──
alter table public.clientes
  add column if not exists country           text,
  add column if not exists street            text,
  add column if not exists city              text,
  add column if not exists state             text,
  add column if not exists zip               text,
  add column if not exists notes             text,
  add column if not exists courier_name      text,
  add column if not exists courier_address   text,
  add column if not exists courier_casillero text,
  add column if not exists courier_phone     text,
  add column if not exists courier_notes     text;

-- ── impresiones (historial de impresión: copia de la factura tal como se imprimió) ──
create table if not exists public.impresiones (
  id          text primary key,
  factura_id  text,
  invoice_num text,
  client_name text,
  total       numeric default 0,
  status      text,
  items_count integer default 0,
  currency    text default 'USD',
  impreso_at  timestamptz default now(),
  created_at  timestamptz default now(),
  factura     jsonb
);
create index if not exists impresiones_impreso_at_idx on public.impresiones (impreso_at desc);

-- Mismo acceso que el resto de tablas de facturación (la app usa la anon key).
alter table public.impresiones enable row level security;
drop policy if exists "impresiones_anon_all" on public.impresiones;
create policy "impresiones_anon_all" on public.impresiones
  for all to anon, authenticated using (true) with check (true);

-- Recargar el esquema de la API para que vea los cambios al instante.
notify pgrst, 'reload schema';
