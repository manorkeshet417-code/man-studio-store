// Man Studio Store — asks a parent to confirm, by email, that their child (under 16) may publish games.
// Runs every 2 minutes (pg_cron). Sends from the store's Gmail account through Gmail's SMTP server.
// Needs two secrets in Supabase: GMAIL_USER (the store's Gmail address) and GMAIL_APP_PASSWORD (a Gmail "app password").
// Without them nothing is sent, and the admin sees "parent email not sent".
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const USER = Deno.env.get("GMAIL_USER") || "";
const PASS = (Deno.env.get("GMAIL_APP_PASSWORD") || "").replace(/\s+/g, "");
const STORE = "https://manorkeshet417-code.github.io/man-studio-store/";
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));

Deno.serve(async () => {
  if (!USER || !PASS) return json({ ok: true, skipped: "email not set up" });
  const { data: list } = await sb.from("parent_consents").select("token,parent_email,child_name,studio_name")
    .is("sent_at", null).is("confirmed_at", null).order("created_at").limit(5);
  if (!list?.length) return json({ ok: true, idle: true });

  const client = new SMTPClient({ connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: USER, password: PASS } } });
  const results: unknown[] = [];
  for (const c of list) {
    const link = `${STORE}#/parent?t=${c.token}`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px">
<h2>Man Studio Store — a parent's approval is needed</h2>
<p>Hello! Your child (username <b>${esc(c.child_name)}</b>, studio <b>${esc(c.studio_name)}</b>) wants to publish their own games on Man Studio Store, a free indie game store with no real money.</p>
<p>Developers under 16 need a parent's approval. If you agree, click here:</p>
<p><a href="${link}" style="background:#5c7e10;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none">I agree</a></p>
<p>If you don't agree, or don't know what this is about, just ignore this email — nothing will happen.</p>
<p style="color:#666;font-size:12px">Terms of Use: ${STORE}#/terms · Privacy Policy: ${STORE}#/privacy · This email address is deleted within 14 days.</p>
<hr><div dir="rtl">
<h2>Man Studio Store — צריך אישור של הורה</h2>
<p>שלום! הילד/ה שלך (שם משתמש <b>${esc(c.child_name)}</b>, סטודיו <b>${esc(c.studio_name)}</b>) רוצה לפרסם משחקים משלו/ה ב-Man Studio Store, חנות משחקי אינדי חינמית בלי כסף אמיתי.</p>
<p>מפתחים מתחת לגיל 16 צריכים אישור של הורה. אם אתם מסכימים, לחצו כאן:</p>
<p><a href="${link}" style="background:#5c7e10;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none">אני מאשר/ת</a></p>
<p>אם אתם לא מסכימים או לא יודעים במה מדובר, פשוט התעלמו מהמייל — שום דבר לא יקרה.</p>
<p style="color:#666;font-size:12px">כתובת המייל הזו נמחקת תוך 14 יום.</p></div></div>`;
    try {
      await client.send({ from: `Man Studio Store <${USER}>`, to: c.parent_email, subject: "Man Studio Store — parent approval needed · צריך אישור הורה", html });
      await sb.from("parent_consents").update({ sent_at: new Date().toISOString(), send_error: null }).eq("token", c.token);
      results.push({ sent: true });
    } catch (e) {
      await sb.from("parent_consents").update({ send_error: String((e as Error).message || e).slice(0, 300) }).eq("token", c.token);
      results.push({ sent: false });
    }
  }
  await client.close();
  return json({ ok: true, results });
});
