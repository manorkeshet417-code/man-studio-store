// Man Studio Store — automatic security scan for submitted games.
// Runs every 2 minutes (pg_cron) and right after a developer saves a game.
// For each game with scan_status = 'pending':
//   • every file (game, demo, source code) is checked on VirusTotal (by hash first, uploaded only if unknown)
//   • external links are checked on VirusTotal as URLs
//   • HTML games are also read line by line for dangerous code (crypto miners, password phishing, hidden code)
// Result: clean → waits for the human review · suspicious → admin sees a warning · malicious → auto-reject + unpublish.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const VT = "https://www.virustotal.com/api/v3";
const VT_KEY = Deno.env.get("VIRUSTOTAL_API_KEY") || "";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MAX_VT_CALLS = 4;            // VirusTotal free API: 4 requests per minute
let vtCalls = 0;

type Stats = { malicious: number; suspicious: number; harmless?: number; undetected?: number };
type Target = { key: string; kind: "file" | "url"; bucket?: string; path?: string; url?: string; name: string; html?: boolean };
type TState = { analysis?: string; sha?: string; stats?: Stats; heur?: string[]; done?: boolean; skipped?: string };

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type, x-client-info" } });

function storageRef(url: string | null): { bucket: string; path: string } | null {
  if (!url) return null;
  const m = url.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/([^?#]+)/);
  return m ? { bucket: m[1], path: decodeURIComponent(m[2]) } : null;
}

function targetsFor(g: any): Target[] {
  const out: Target[] = [];
  const add = (key: string, kind: string | null, url: string | null, name: string) => {
    if (!url) return;
    const ref = storageRef(url);
    if (ref) out.push({ key, kind: "file", bucket: ref.bucket, path: ref.path, name, html: kind === "html" });
    else if (/^https?:\/\//i.test(url)) out.push({ key, kind: "url", url, name });
  };
  add("game", g.play_kind, g.play_url, g.file_name || "game");
  add("demo", g.demo_kind, g.demo_url, g.demo_file_name || "demo");
  if (g.source_path) out.push({ key: "source", kind: "file", bucket: "sources", path: g.source_path, name: g.source_name || "source.zip" });
  return out;
}

// ---------- HTML code check (no outside service needed) ----------
const HEUR: [RegExp, string, "bad" | "warn"][] = [
  [/coinhive|cryptonight|coin-?hive|webminepool|crypto-?loot|minero\.cc|deepminer|coinimp|jsecoin|\bminer\.start\(/i, "crypto miner code", "bad"],
  [/new\s+WebSocket\([^)]*(pool|mine|stratum)/i, "connects to a mining pool", "bad"],
  [/<input[^>]+type\s*=\s*["']?password/i, "asks for a password (possible phishing)", "warn"],
  [/(window\.)?top\.location(\.href)?\s*=|parent\.location(\.href)?\s*=/i, "tries to redirect the store page", "warn"],
  [/eval\s*\(\s*(atob|unescape|decodeURIComponent)\s*\(/i, "runs hidden (encoded) code", "warn"],
  [/document\.cookie/i, "reads cookies", "warn"],
  [/navigator\.credentials|PasswordCredential/i, "tries to read saved passwords", "bad"],
  [/\.exe["'`]\s*[,)]|download\s*=\s*["'][^"']+\.(exe|bat|cmd|scr|ps1|vbs)["']/i, "tries to download a program to the player's computer", "warn"],
];
function htmlCheck(text: string): { bad: string[]; warn: string[] } {
  const bad: string[] = [], warn: string[] = [];
  for (const [re, label, lvl] of HEUR) if (re.test(text)) (lvl === "bad" ? bad : warn).push(label);
  // very long encoded blobs are a common way to hide code
  const blob = text.match(/["'`][A-Za-z0-9+/=]{20000,}["'`]/);
  if (blob && !/data:(image|audio|font)\//i.test(text.slice(Math.max(0, (blob.index || 0) - 40), (blob.index || 0)))) warn.push("very large hidden (encoded) block");
  return { bad, warn };
}

async function sha256(buf: ArrayBuffer) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function vt(path: string, init: RequestInit = {}) {
  vtCalls++;
  const r = await fetch(VT + path, { ...init, headers: { "x-apikey": VT_KEY, ...(init.headers || {}) } });
  if (r.status === 429) throw new Error("RATE");
  return r;
}

// One step of work for a target. Returns true when the target is finished.
async function step(t: Target, st: TState): Promise<boolean> {
  if (st.done) return true;
  if (!VT_KEY) {
    if (t.kind === "file" && t.html && !st.heur) {
      const { data } = await sb.storage.from(t.bucket!).download(t.path!);
      if (data) { const h = htmlCheck(await data.text()); st.heur = [...h.bad.map((x) => "!" + x), ...h.warn]; }
    }
    st.skipped = "no VirusTotal key"; st.done = true; return true;
  }
  if (vtCalls >= MAX_VT_CALLS) return false;

  if (st.analysis) {                                  // waiting for a VirusTotal result
    const r = await vt(`/analyses/${st.analysis}`);
    const j = await r.json();
    if (j?.data?.attributes?.status === "completed") { st.stats = j.data.attributes.stats; st.done = true; return true; }
    return false;
  }

  if (t.kind === "url") {
    const r = await vt("/urls", { method: "POST", body: new URLSearchParams({ url: t.url! }) });
    const j = await r.json();
    if (!j?.data?.id) throw new Error("VirusTotal URL scan failed");
    st.analysis = j.data.id; return false;
  }

  // file: download it from storage, check the code if it's HTML, then look it up by hash
  const { data, error } = await sb.storage.from(t.bucket!).download(t.path!);
  if (error || !data) { st.skipped = "file missing"; st.done = true; return true; }
  const buf = await data.arrayBuffer();
  if (t.html && !st.heur) { const h = htmlCheck(new TextDecoder().decode(buf)); st.heur = [...h.bad.map((x) => "!" + x), ...h.warn]; }
  st.sha = await sha256(buf);
  const look = await vt(`/files/${st.sha}`);
  if (look.status === 200) {
    const j = await look.json(); const s = j?.data?.attributes?.last_analysis_stats;
    if (s && (s.malicious + s.suspicious + (s.harmless || 0) + (s.undetected || 0)) > 0) { st.stats = s; st.done = true; return true; }
  }
  // source code stays private: it's only checked by fingerprint, never uploaded to VirusTotal
  if (t.key === "source") { st.skipped = "fingerprint not known to VirusTotal (kept private, not uploaded)"; st.done = true; return true; }
  if (vtCalls >= MAX_VT_CALLS) return false;
  // unknown file: upload it (files over 32 MB need a special upload address)
  let upUrl = VT + "/files";
  if (buf.byteLength > 32 * 1048576) {
    const u = await vt("/files/upload_url"); const uj = await u.json(); upUrl = uj.data;
    if (vtCalls >= MAX_VT_CALLS) return false;
  }
  const fd = new FormData(); fd.append("file", new Blob([buf]), t.name.replace(/[^\w.\-]/g, "_") || "file");
  vtCalls++;
  const up = await fetch(upUrl, { method: "POST", headers: { "x-apikey": VT_KEY }, body: fd });
  if (up.status === 429) throw new Error("RATE");
  const uj = await up.json();
  if (!uj?.data?.id) throw new Error("VirusTotal upload failed");
  st.analysis = uj.data.id; return false;
}

function verdict(targets: Target[], state: Record<string, TState>) {
  const bad: string[] = [], warn: string[] = [], info: string[] = [];
  for (const t of targets) {
    const st = state[t.key] || {}; const label = t.key === "source" ? "source code" : t.key === "demo" ? "demo" : "game";
    for (const h of st.heur || []) (h.startsWith("!") ? bad : warn).push(`${label}: ${h.replace(/^!/, "")}`);
    const s = st.stats;
    if (s) {
      if (s.malicious >= 3) bad.push(`${label}: ${s.malicious} antivirus engines found malware`);
      else if (s.malicious > 0 || s.suspicious >= 3) warn.push(`${label}: ${s.malicious} malicious / ${s.suspicious} suspicious detections`);
      else info.push(`${label}: clean (${(s.harmless || 0) + (s.undetected || 0)} engines)`);
    }
    if (st.skipped) info.push(`${label}: ${st.skipped}`);
  }
  const status = bad.length ? "malicious" : warn.length ? "suspicious" : (!VT_KEY ? "error" : "clean");
  const detail = [...bad.map((x) => "⛔ " + x), ...warn.map((x) => "⚠️ " + x), ...info.map((x) => "✓ " + x)].join("\n").slice(0, 3000);
  return { status, detail, bad };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({});
  // don't run more than once every 20 seconds (protects the VirusTotal daily limit)
  const { data: last } = await sb.from("games").select("scan_claimed_at").not("scan_claimed_at", "is", null).order("scan_claimed_at", { ascending: false }).limit(1);
  if (last?.[0] && Date.now() - +new Date(last[0].scan_claimed_at) < 20000) return json({ ok: true, skipped: "busy" });

  // take up to 2 games: pending ones, or ones stuck in 'scanning' for 5+ minutes
  const stale = new Date(Date.now() - 5 * 60000).toISOString();
  const { data: list } = await sb.from("games")
    .select("id,title,owner,play_kind,play_url,file_name,demo_kind,demo_url,demo_file_name,source_path,source_name,scan_status,scan_ref,review_status")
    .or(`scan_status.eq.pending,and(scan_status.eq.scanning,scan_claimed_at.lt.${stale})`).order("updated_at").limit(2);
  const results: unknown[] = [];
  for (const g of list || []) {
    // claim it (another run can't take it at the same time)
    const { data: claimed } = await sb.from("games").update({ scan_status: "scanning", scan_claimed_at: new Date().toISOString() })
      .eq("id", g.id).in("scan_status", ["pending", "scanning"]).select("id");
    if (!claimed?.length) continue;
    const targets = targetsFor(g);
    const state: Record<string, TState> = (g.scan_ref && typeof g.scan_ref === "object") ? g.scan_ref : {};
    let allDone = true, err = "";
    try { for (const t of targets) { state[t.key] = state[t.key] || {}; if (!(await step(t, state[t.key]))) allDone = false; } }
    catch (e) { allDone = false; err = String((e as Error).message || e); }

    if (!allDone) {   // continue on the next run
      await sb.from("games").update({ scan_status: "pending", scan_ref: state }).eq("id", g.id).eq("scan_status", "scanning");
      results.push({ id: g.id, waiting: true, err }); continue;
    }
    const v = verdict(targets, state);
    const upd: Record<string, unknown> = { scan_status: v.status, scan_detail: v.detail || "✓ nothing to scan", scan_ref: state, scanned_at: new Date().toISOString() };
    if (v.status === "malicious") {
      // automatic decision: reject, hide, and remove the infected files so nobody can download them
      Object.assign(upd, { review_status: "rejected", published: false, reviewed_at: new Date().toISOString(),
        reject_reason: "Automatic security scan found dangerous content:\n" + v.bad.join("\n"), fix_deadline: new Date(Date.now() + 30 * 864e5).toISOString() });
      const rm: Record<string, string[]> = {};
      for (const t of targets) if (t.kind === "file" && v.bad.some((b) => b.startsWith(t.key === "source" ? "source code" : t.key))) (rm[t.bucket!] ||= []).push(t.path!);
      for (const [b, paths] of Object.entries(rm)) await sb.storage.from(b).remove(paths);
      if (rm.media?.length) { if (targets.find((t) => t.key === "game" && rm.media.includes(t.path!))) upd.play_url = null;
                              if (targets.find((t) => t.key === "demo" && rm.media.includes(t.path!))) upd.demo_url = null; }
      await sb.from("notifications").insert({ user_id: g.owner, kind: "security", title: "⛔ Security scan: " + g.title, body: "Your game was rejected automatically. Reason: " + v.bad.join("; ").slice(0, 400), link: "#/edit/" + g.id });
    }
    await sb.from("games").update(upd).eq("id", g.id);
    results.push({ id: g.id, status: v.status });
  }
  return json({ ok: true, vtCalls, results });
});
