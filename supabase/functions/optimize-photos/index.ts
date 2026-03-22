import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Image } from "https://deno.land/x/imagescript@1.2.15/mod.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Cargar todos los productos con foto URL
  const { data: rows, error } = await supabase
    .from("catalogo_productos")
    .select("id, photo_data")
    .not("photo_data", "is", null);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  const conFoto = (rows ?? []).filter(
    (r) => r.photo_data && r.photo_data.startsWith("http")
  );

  let ok = 0, errors = 0;

  for (const row of conFoto) {
    try {
      // Descargar imagen original
      const resp = await fetch(row.photo_data);
      const buffer = new Uint8Array(await resp.arrayBuffer());

      // Decodificar, redimensionar y recodificar con imagescript
      const img = await Image.decode(buffer);
      const MAX = 1200;
      if (img.width > MAX || img.height > MAX) {
        if (img.width >= img.height) img.resize(MAX, Image.RESIZE_AUTO);
        else img.resize(Image.RESIZE_AUTO, MAX);
      }
      const compressed = await img.encodeJPEG(78); // calidad 78%

      // Subir nueva foto comprimida
      const filename = `product_${Date.now()}_${row.id}.jpg`;
      const { data: uploaded, error: upErr } = await supabase.storage
        .from("product-photos")
        .upload(filename, compressed, {
          contentType: "image/jpeg",
          upsert: false,
        });

      if (upErr) throw upErr;

      const {
        data: { publicUrl },
      } = supabase.storage.from("product-photos").getPublicUrl(uploaded.path);

      // Actualizar registro en BD
      await supabase
        .from("catalogo_productos")
        .update({ photo_data: publicUrl })
        .eq("id", row.id);

      // Eliminar archivo anterior del bucket para liberar espacio
      try {
        const oldPath = decodeURIComponent(
          row.photo_data.split("/product-photos/")[1]
        );
        if (oldPath) {
          await supabase.storage.from("product-photos").remove([oldPath]);
        }
      } catch (_) {
        // Si no se puede borrar el antiguo, continuar igual
      }

      ok++;
    } catch (e) {
      console.error("Error optimizando foto id=" + row.id, e);
      errors++;
    }
  }

  return new Response(
    JSON.stringify({ ok, errors, total: conFoto.length }),
    { headers: { ...CORS, "Content-Type": "application/json" } }
  );
});
