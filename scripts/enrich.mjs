// Slår opp artikkelsiden for saker som skal vises:
//  1) avisas egen adresse bak Google Nyheter-lenker (feeden gir bare en omvei via news.google.com)
//  2) bilde (og:image)
//  3) om saken er en pluss-sak
// Feil her stopper aldri innsamlingen – saken vises da uten bilde og uten pluss-merke.

const BOT_UA = 'Mozilla/5.0 (compatible; GodeNyheter/1.7; link preview)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const G = 'https://news.google.com';
const DEBUG = /^(1|true)$/i.test(process.env.DEBUG_ENRICH || '');
const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '?'; } };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

export const isGoogleLink = (url) => { try { return new URL(url).hostname === 'news.google.com'; } catch { return false; } };
const googleId = (url) => { try { return new URL(url).pathname.match(/\/articles\/([^/?]+)/)?.[1] || null; } catch { return null; } };

// Eldre Google-lenker har adressen innbakt i ID-en. Nyere («AU_yqL…») må slås opp hos Google.
function inlineUrl(id) {
  try {
    const s = Buffer.from(id, 'base64url').toString('latin1');
    const i = s.indexOf('http');
    if (i < 0) return null;
    const u = s.slice(i).split(/[^\x21-\x7e]/)[0];
    return /^https?:\/\/[^/]+\.[a-z]{2,}/i.test(u) ? u : null;
  } catch { return null; }
}

/** Finner avisas egen adresse bak en Google Nyheter-lenke. Kaster feil hvis Google ikke svarer som ventet. */
export async function resolveGoogleLink(url) {
  const id = googleId(url);
  if (!id) throw new Error('ukjent lenkeformat');
  const inline = inlineUrl(id);
  if (inline) return inline;

  // Steg 1: artikkelsiden hos Google inneholder en signatur og et tidsstempel for denne ID-en
  let sg, ts, why = 'siden mangler signatur';
  for (const path of [`/articles/${id}`, `/rss/articles/${id}`]) {
    const res = await fetch(G + path, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) { why = `HTTP ${res.status}`; await res.body?.cancel(); continue; }
    const html = await res.text();
    sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
    ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (sg && ts) break;
  }
  if (!sg || !ts) throw new Error(`Google ga ikke signatur (${why})`);

  // Steg 2: bytt ID + signatur mot den egentlige adressen
  const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
    'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg]);
  const res = await fetch(`${G}/_/DotsSplashUi/data/batchexecute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': BROWSER_UA },
    body: 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner]]])),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`Google svarte HTTP ${res.status}`); }
  const text = await res.text();
  let target = null;
  try {
    const rows = JSON.parse(text.split('\n').find((l) => l.startsWith('[[')));
    target = JSON.parse(rows.find((r) => r[1] === 'Fbv4je')[2])[1];
  } catch {
    const m = text.match(/garturlres\\",\\"(https?:[^"\\]+)/);
    if (m) target = m[1];
  }
  if (!/^https?:\/\//i.test(target || '') || isGoogleLink(target)) throw new Error('uventet svar fra Google');
  return target;
}

/** Leser bilde og pluss-merking ut av artikkelsidens HTML. paywall: true = pluss, false = åpen, null = vet ikke. */
export function readArticlePage(html, pageUrl) {
  const meta = (p) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']+)["']`, 'i'))?.[1]
                   || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${p}["']`, 'i'))?.[1];
  let image = null;
  const raw = meta('og:image') || meta('og:image:secure_url') || meta('twitter:image') || meta('twitter:image:src');
  if (raw) {
    try { const abs = new URL(raw.replace(/&amp;/g, '&'), pageUrl).toString(); if (isHttps(abs)) image = abs; } catch {}
  }
  // Pluss: avisene merker betalt innhold med schema.org (isAccessibleForFree) overfor Google
  // og med Open Graph (article:content_tier) overfor Facebook.
  const flags = [...html.matchAll(/"isAccessibleForFree"\s*:\s*"?(true|false)"?/gi)].map((m) => m[1].toLowerCase());
  const tier = (meta('article:content_tier') || '').toLowerCase();
  let paywall = null;
  if (flags.includes('false') || tier === 'locked' || tier === 'metered') paywall = true;
  else if (flags.includes('true') || tier === 'free') paywall = false;
  return { image, paywall, flags, tier };
}

async function fetchArticlePage(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': BOT_UA, Accept: 'text/html,application/xhtml+xml' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) { await res.body?.cancel(); return { ok: false, status: res.status }; }
  const html = (await res.text()).slice(0, 800000);
  const info = readArticlePage(html, res.url || url);
  if (DEBUG) {
    // Feilsøking: hvilke spor av betalingsmur finnes på siden? Brukes for å forbedre pluss-gjenkjenningen.
    const hints = [...new Set((html.match(/[\w:."'= -]{0,40}(?:paywall|isAccessibleForFree|content_tier|premium|pluss)[\w:."'= -]{0,40}/gi) || []).map((s) => s.trim()))].slice(0, 8);
    console.log(`  [oppslag] ${hostOf(res.url || url)} bilde=${info.image ? 'ja' : 'nei'} pluss=${info.paywall} flagg=${info.flags.join('/') || '-'} tier=${info.tier || '-'}${hints.length ? '\n      ' + hints.join('\n      ') : ''}`);
  }
  return { ok: true, ...info };
}

/**
 * Lager en «oppslager» med et tak for antall sider per kjøring.
 * enrich(row) returnerer feltene som skal lagres på saken, eller null hvis saken må prøves igjen i en senere kjøring.
 * row trenger url, direct_url, image_url og paywall.
 */
export function makeEnricher({ maxLookups = 60 } = {}) {
  const s = { used: 0, gTried: 0, gOk: 0, gFailRow: 0, images: 0, plus: 0, open: 0, firstErr: null };
  const gaveUp = new Set();   // lenker Google ikke ville løse i denne kjøringen – prøves ikke to ganger
  async function enrich(row) {
    const now = new Date().toISOString();
    const viaGoogle = isGoogleLink(row.url);
    const needLink = viaGoogle && !row.direct_url;
    if (!needLink && row.image_url) return { enriched_at: now };          // har alt vi kan få uten å åpne siden
    if (s.used >= maxLookups) return null;                                  // taket er nådd – tas i neste kjøring
    if (needLink && (s.gFailRow >= 3 || gaveUp.has(row.url))) return null;  // Google svarer ikke nå – ikke mas, prøv igjen i neste kjøring
    s.used++;
    const patch = { enriched_at: now };
    let target = row.direct_url || null;
    if (needLink) {
      s.gTried++;
      try {
        if (s.gTried > 1) await sleep(300);
        target = await resolveGoogleLink(row.url);
        patch.direct_url = target; s.gOk++; s.gFailRow = 0;
      } catch (e) {
        s.gFailRow++; s.firstErr ||= e.message; gaveUp.add(row.url);
        return null;
      }
    }
    try {
      const page = await fetchArticlePage(target || row.url);
      if (page.ok) {
        if (!row.image_url && page.image) { patch.image_url = page.image; s.images++; }
        if (page.paywall != null) { patch.paywall = page.paywall; page.paywall ? s.plus++ : s.open++; }
      } else if (DEBUG) console.log(`  [oppslag] ${hostOf(target || row.url)} svarte HTTP ${page.status}`);
    } catch (e) { if (DEBUG) console.log(`  [oppslag] ${hostOf(target || row.url)}: ${e.message}`); }
    return patch;
  }
  const summary = () => `Oppslag på artikkelsider: ${s.used} – ${s.gOk} av ${s.gTried} Google-lenker løst, ${s.images} bilder funnet, ${s.plus} pluss-saker og ${s.open} åpne merket.`
    + (s.firstErr ? ` Første feil hos Google: ${s.firstErr}.` : '');
  return { enrich, summary, stats: s };
}
