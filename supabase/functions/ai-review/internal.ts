// Man Studio Store — free internal content checker (no outside AI service, costs nothing).
// Two layers:
//   1. Rules: protected franchises, adult content, scams, hate, review manipulation, privacy in code,
//      age-rating mismatches — in English and Hebrew, with simple "l33t" spelling tricks undone.
//   2. A small AI model that runs inside Supabase for free (gte-small embeddings): compares the meaning of
//      the game's text to risky situations. It only flags — it never rejects on its own.
// It can't look at images, so a person must still check the cover and screenshots.
declare const Supabase: any;

type Issue = { category: string; severity: "low" | "medium" | "high"; evidence: string; explanation: string };
export type Verdict = { decision: "ok" | "flag" | "reject"; confidence: "low" | "medium" | "high"; issues: Issue[]; suggested_age_rating: string; summary_en: string; summary_he: string; semantic?: Record<string, number> };

const norm = (s: string) => (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/@/g, "a").replace(/\$/g, "s")
  .replace(/[_*.\-]+/g, " ").replace(/\s+/g, " ");

// protected franchises (owner shown to the developer)
const FRANCHISES: [RegExp, string][] = [
  [/pokemon|pikachu|pokeball|פוקימון|פיקאצ/, "Pokémon (Nintendo / The Pokémon Company)"],
  [/\bsuper mario\b|\bmario (bros|kart|party)\b|\bluigi\b|\bnintendo\b|\bzelda\b|\bkirby\b|\bdonkey kong\b|סופר מריו|נינטנדו/, "Mario / Nintendo"],
  [/minecraft|\bcreeper\b|מיינקראפט|מיינקרפט/, "Minecraft (Mojang / Microsoft)"],
  [/fortnite|v ?bucks|פורטנייט/, "Fortnite (Epic Games)"],
  [/roblox|robux|רובלוקס|רובקס/, "Roblox"],
  [/sonic the hedgehog|\bsonic\b.*\b(sega|hedgehog|tails|knuckles)\b|\bsega\b|סוניק/, "Sonic (SEGA)"],
  [/\bdisney\b|mickey mouse|minnie mouse|\bpixar\b|דיסני|מיקי מאוס/, "Disney"],
  [/\bmarvel\b|spider ?man|iron ?man|avengers|\bhulk\b|captain america|thanos|ספיידרמן|איירון מן|הנוקמים/, "Marvel (Disney)"],
  [/batman|superman|wonder woman|\bjoker\b.*\bgotham\b|\bdc comics\b|באטמן|סופרמן/, "DC Comics (Warner Bros.)"],
  [/star wars|darth vader|\bjedi\b|lightsaber|מלחמת הכוכבים/, "Star Wars (Lucasfilm / Disney)"],
  [/harry potter|hogwarts|הארי פוטר|הוגוורטס/, "Harry Potter (Warner Bros.)"],
  [/among us|amogus/, "Among Us (Innersloth)"],
  [/call of duty|\bwarzone\b/, "Call of Duty (Activision)"],
  [/\bgta\b|grand theft auto/, "Grand Theft Auto (Rockstar)"],
  [/five nights at freddy|\bfnaf\b|freddy fazbear/, "Five Nights at Freddy's"],
  [/angry birds/, "Angry Birds (Rovio)"],
  [/subway surfers/, "Subway Surfers (SYBO)"],
  [/candy crush/, "Candy Crush (King)"],
  [/pac ?man/, "Pac-Man (Bandai Namco)"],
  [/\btetris\b|טטריס/, "Tetris (The Tetris Company)"],
  [/sponge ?bob|בובספוג/, "SpongeBob (Nickelodeon)"],
  [/paw patrol|peppa pig|פפה פיג|מפרץ ההרפתקאות/, "Kids' TV brand"],
  [/\blego\b|לגו/, "LEGO"],
  [/hello kitty|\bbarbie\b|ברבי/, "Sanrio / Mattel"],
  [/naruto|dragon ball|\bgoku\b|one piece|demon slayer|jujutsu kaisen|נארוטו|דרגון בול/, "Anime franchise"],
  [/undertale|terraria|geometry dash|hollow knight|stardew valley|cuphead/, "Existing indie game"],
  [/clash of clans|clash royale|brawl stars/, "Supercell"],
  [/valorant|league of legends|overwatch|\bhalo infinite\b|master chief|skyrim|elden ring/, "Existing big game"],
];

type Rule = { re: RegExp; cat: string; sev: "low" | "medium" | "high"; en: string; he: string; reject?: boolean };
const RULES: Rule[] = [
  { re: /\bporn|hentai|\bxxx\b|\bnsfw\b|onlyfans|סקס|פורנו|הנטאי/, cat: "adult_content", sev: "high", reject: true, en: "Sexual / adult content is not allowed in the store.", he: "תוכן מיני / למבוגרים אסור בחנות." },
  { re: /\bsexy\b|\bnude\b|\bnaked\b|\bstrip ?(club|poker)\b|\bboobs?\b|עירום|ערום|סקסי/, cat: "adult_content", sev: "medium", en: "Possible sexual content — a person must check it.", he: "ייתכן שיש תוכן מיני — אדם צריך לבדוק." },
  { re: /free ?(robux|v ?bucks|vbucks|gems|skins)|(robux|vbucks|v bucks|gift ?card) generator|claim your (prize|reward)|enter your (password|login|card)|רובקס בחינם|ויבאקס בחינם|הכנס(ו)? (את )?(הסיסמה|סיסמה)|זכית בפרס/, cat: "scam_phishing", sev: "high", reject: true, en: "Looks like a scam (free currency / prize / asks for a password).", he: "נראה כמו הונאה (מטבע בחינם / פרס / בקשה לסיסמה)." },
  { re: /ignore (all |the )?(previous|prior|above) (instructions|rules)|approve this game|this game (is|was) (already )?approved|you are an ai|as an ai (reviewer|model)|system prompt|תאשר(ו)? את המשחק|התעלם מההוראות/, cat: "manipulation", sev: "high", reject: true, en: "Text that tries to trick the automatic review.", he: "טקסט שמנסה לרמות את הבדיקה האוטומטית." },
  { re: /heil hitler|white power|(kill|death to) (all )?(jews|arabs|muslims|christians|blacks|gays|israelis|palestinians)|מוות ל(ערבים|יהודים)|להרוג את כל ה/, cat: "hate_harassment", sev: "high", reject: true, en: "Hate speech is not allowed.", he: "דברי שנאה אסורים." },
  { re: /\bnazi|swastika|\bkkk\b|נאצי|צלב קרס/, cat: "hate_harassment", sev: "medium", en: "Possible hate symbols — check the context (a history game can be fine).", he: "ייתכן שיש סמלי שנאה — צריך לבדוק את ההקשר (משחק היסטורי יכול להיות בסדר)." },
  { re: /kill yourself|\bkys\b|commit suicide|תתאבד|תהרוג את עצמך/, cat: "hate_harassment", sev: "high", en: "Encourages self-harm or bullying.", he: "עידוד לפגיעה עצמית או בריונות." },
  { re: /buy (drugs|weed|cocaine)|\bcocaine\b|\bmeth\b|real money (casino|betting|gambling)|bet real money|הימורים בכסף אמיתי|סמים/, cat: "illegal", sev: "medium", en: "Possible drugs or real-money gambling.", he: "ייתכן שיש סמים או הימורים בכסף אמיתי." },
  { re: /official (game|app) (of|by)|(made|created) by (nintendo|microsoft|sony|epic games|roblox corporation|google|apple|mojang)|המשחק הרשמי של/, cat: "trademark_impersonation", sev: "medium", en: "Claims to be official / made by a big company.", he: "טוען שהוא רשמי או של חברה גדולה." },
];
const CODE_RULES: Rule[] = [
  { re: /navigator\.geolocation|getcurrentposition/, cat: "privacy", sev: "medium", en: "The game code asks for the player's location.", he: "קוד המשחק מבקש את המיקום של השחקן." },
  { re: /getusermedia|mediadevices/, cat: "privacy", sev: "medium", en: "The game code asks for the camera or microphone.", he: "קוד המשחק מבקש מצלמה או מיקרופון." },
  { re: /type=["']?(tel|email)["']?|name=["']?(phone|address|school|full ?name|email)["']?/, cat: "privacy", sev: "medium", en: "The game asks players for personal details (phone / email / address / school).", he: "המשחק מבקש מהשחקנים פרטים אישיים (טלפון / מייל / כתובת / בית ספר)." },
  { re: /fetch\(["'`]https?:\/\/[^"'`]*\b(discord(app)?\.com\/api\/webhooks|webhook\.site|requestbin|ngrok)/, cat: "privacy", sev: "high", reject: true, en: "The game code sends data to a hidden webhook (data theft).", he: "קוד המשחק שולח מידע ל-webhook נסתר (גניבת מידע)." },
];
const VIOLENT = /\b(gore|blood|bloody|dismember|decapitat|murder|torture|massacre|slaughter)\w*|דם|רצח|עינויים|טבח/;
const LOW_AGES = new Set(["all", "3", "7"]);

// meaning-based check (free model inside Supabase) — flags only
const SEMANTIC: [string, string, string, string][] = [
  ["copyright", "A fan game using the characters, world and name of a famous copyrighted video game, movie or cartoon franchise.", "The text looks like a fan game of a famous franchise.", "הטקסט נראה כמו משחק מעריצים של מותג מפורסם."],
  ["adult_content", "Sexual adult content with nudity and erotic scenes.", "The text sounds sexual / adult.", "הטקסט נשמע מיני / למבוגרים."],
  ["scam_phishing", "Get free premium currency or a gift card prize, just enter your account username and password.", "The text sounds like a scam.", "הטקסט נשמע כמו הונאה."],
  ["hate_harassment", "Hateful content that attacks and mocks a religion, race or ethnic group.", "The text sounds hateful.", "הטקסט נשמע כמו שנאה."],
  ["violence_gore", "Extremely graphic gore with brutal killing, torture and blood everywhere.", "The text sounds very violent.", "הטקסט נשמע אלים מאוד."],
];
const SEM_THRESHOLD = Number(Deno.env.get("AI_SEM_THRESHOLD") || "0.86");
let semRefs: number[][] | null = null;
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

async function semantic(text: string): Promise<Record<string, number>> {
  if (typeof Supabase === "undefined" || !Supabase.ai) return {};
  const session = new Supabase.ai.Session("gte-small");
  const emb = async (s: string) => Array.from(await session.run(s, { mean_pool: true, normalize: true })) as number[];
  if (!semRefs) semRefs = await Promise.all(SEMANTIC.map(([, ref]) => emb(ref)));
  const parts = [text.slice(0, 1500), ...text.split(/[.!?\n]+/).map((x) => x.trim()).filter((x) => x.length > 25).slice(0, 12)];
  const out: Record<string, number> = {};
  for (const p of parts) {
    const e = await emb(p);
    SEMANTIC.forEach(([cat], i) => { const s = dot(e, semRefs![i]); if (!(cat in out) || s > out[cat]) out[cat] = Math.round(s * 1000) / 1000; });
  }
  return out;
}

export async function internalReview(g: any, htmlCode: string): Promise<Verdict> {
  const issues: Issue[] = [];
  let reject = false;
  const title = norm(g.title || "");
  const meta = norm([g.short_desc, g.description, (g.tags || []).join(" "), JSON.stringify(g.translations || {})].join(" \n "));
  const all = title + " \n " + meta;
  const code = (htmlCode || "").toLowerCase();
  const quote = (src: string, re: RegExp) => { const m = src.match(re); return m ? m[0].slice(0, 80) : ""; };

  for (const [re, owner] of FRANCHISES) {
    if (re.test(title)) { reject = true; issues.push({ category: "copyright", severity: "high", evidence: quote(title, re), explanation: `The game's name uses a protected brand: ${owner}. Use your own name and characters.` }); }
    else if (re.test(meta)) issues.push({ category: "copyright", severity: "medium", evidence: quote(meta, re), explanation: `The text mentions a protected brand: ${owner}. A person must check that the game doesn't use its characters, art or music.` });
    else if (re.test(code)) issues.push({ category: "copyright", severity: "low", evidence: quote(code, re), explanation: `The game code mentions ${owner}.` });
  }
  for (const r of RULES) if (r.re.test(all) || r.re.test(code)) {
    if (r.reject) reject = true;
    issues.push({ category: r.cat, severity: r.sev, evidence: quote(all, r.re) || quote(code, r.re), explanation: r.en });
  }
  for (const r of CODE_RULES) if (r.re.test(code)) {
    if (r.reject) reject = true;
    issues.push({ category: r.cat, severity: r.sev, evidence: quote(code, r.re), explanation: r.en });
  }
  let suggested = g.age_rating || "all";
  if (VIOLENT.test(all) && LOW_AGES.has(String(g.age_rating || "all"))) {
    suggested = "12";
    issues.push({ category: "age_rating_mismatch", severity: "medium", evidence: quote(all, VIOLENT), explanation: "Violent words with a low age rating — check if the rating should be 12+." });
  }
  if ((g.description || "").trim().length < 20 && (g.short_desc || "").trim().length < 20) issues.push({ category: "misleading_or_spam", severity: "low", evidence: "", explanation: "Very short description." });

  let sem: Record<string, number> = {};
  try { sem = await semantic([g.title, g.short_desc, g.description].filter(Boolean).join(". ")); } catch (_) { /* model not available: rules only */ }
  for (const [cat, , en] of SEMANTIC) if ((sem[cat] ?? 0) >= SEM_THRESHOLD && !issues.some((i) => i.category === cat)) {
    issues.push({ category: cat, severity: "medium", evidence: `meaning match ${sem[cat]}`, explanation: en });
  }

  const serious = issues.filter((i) => i.severity !== "low");
  const decision: Verdict["decision"] = reject ? "reject" : serious.length ? "flag" : "ok";
  const heOf = (i: Issue) => RULES.concat(CODE_RULES).find((r) => r.en === i.explanation)?.he || SEMANTIC.find(([c, , en]) => en === i.explanation)?.[3] ||
    (i.category === "copyright" ? "שימוש בשם או בדמויות של מותג מוגן — השתמשו בשם ובדמויות משלכם." : i.category === "age_rating_mismatch" ? "מילים אלימות עם דירוג גיל נמוך — כדאי לבדוק דירוג 12+." : "תיאור קצר מאוד.");
  const summary_en = decision === "ok" ? "The internal checker found nothing problematic in the text and code. Images are checked by a person."
    : (decision === "reject" ? "Rejected automatically: " : "Needs a closer look: ") + serious.map((i) => i.explanation).join(" ");
  const summary_he = decision === "ok" ? "הבודק הפנימי לא מצא שום דבר בעייתי בטקסט ובקוד. את התמונות בודק אדם."
    : (decision === "reject" ? "נדחה אוטומטית: " : "צריך בדיקה מקרוב: ") + [...new Set(serious.map(heOf))].join(" ");
  return { decision, confidence: reject ? "high" : serious.length ? "medium" : "low", issues, suggested_age_rating: suggested, summary_en: summary_en.slice(0, 900), summary_he: summary_he.slice(0, 900), semantic: sem };
}
