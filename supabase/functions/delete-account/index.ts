// Man Studio Store — "Delete my account".
// The signed-in user deletes their own account: their files (game builds, images, source code) are removed from
// storage, then the login itself is deleted, which deletes everything else linked to it (profile, games, reviews,
// library, purchases, notifications...). The admin account can't be deleted this way.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type, x-client-info" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...cors } });

async function removeFolder(bucket: string, folder: string) {
  for (let i = 0; i < 20; i++) {
    const { data } = await admin.storage.from(bucket).list(folder, { limit: 100 });
    if (!data?.length) return;
    await admin.storage.from(bucket).remove(data.map((f) => `${folder}/${f.name}`));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({});
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error } = await admin.auth.getUser(token);
  if (error || !u?.user) return json({ error: "NOT_SIGNED_IN" }, 401);
  const uid = u.user.id;
  const body = await req.json().catch(() => ({}));
  const { data: prof } = await admin.from("profiles").select("username,is_admin").eq("id", uid).maybeSingle();
  if (!prof) return json({ error: "NOT_FOUND" }, 404);
  if (prof.is_admin) return json({ error: "ADMIN_CANT_DELETE" }, 400);
  // the user types their username to confirm
  if (String(body.confirm || "").trim().toLowerCase() !== String(prof.username).toLowerCase()) return json({ error: "CONFIRM_MISMATCH" }, 400);

  await removeFolder("media", uid);
  await removeFolder("sources", uid);
  const del = await admin.auth.admin.deleteUser(uid);
  if (del.error) return json({ error: del.error.message }, 500);
  return json({ ok: true });
});
