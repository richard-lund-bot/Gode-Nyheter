// Fellesturer («Bli med»): bare verifiserte turruter fra ut.no (eller andre godkjente tursider).
// 1) Claude søker etter turforslag på ut.no for hvert område (web search, begrenset til godkjente domener)
// 2) Scriptet åpner hver side selv og sjekker at den finnes og er en turbeskrivelse – først da godkjennes turen
// 3) Planleggeren velger en verifisert tur for en fin helgedag. Ingen klokkeslett – bare en oppfordring.
import { kindOf, OUTDOOR } from './weather.mjs';

// Godkjente tursider: domene → regel for hva som er en turbeskrivelse
export const VERIFIED_SOURCES = {
  'ut.no': (u) => /^\/turforslag\/\d+/.test(u.pathname),
};
const MIN_SPOTS = 6;          // let etter flere når et område har færre verifiserte turer
const REVERIFY_DAYS = 30;     // sjekk lenkene på nytt med jevne mellomrom
const AVOID_DAYS = 21;        // ikke gjenta samme tur innen dette antall dager
const CAPACITY = 30;          // når en tur har så mange deltakere, foreslås neste tur i tillegg
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const SEARCH_MODEL = process.env.CLAUDE_SEARCH_MODEL || MODEL;

const TZ = 'Europe/Oslo';
const ymd = (d) => d.toLocaleDateString('sv-SE', { timeZone: TZ });
const dow = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, des: 12 };

// ---------- Verifisering av en turside ----------
export function isVerifiedSourceUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^www\./, '');
    return Boolean(VERIFIED_SOURCES[host]?.(u));
  } catch { return false; }
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Leser fakta fra en ut.no-side: navn, vanskelighetsgrad, type, lengde, tid og sesong. */
export function parseTripPage(html) {
  const meta = (p) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']+)["']`, 'i'))?.[1]
                  || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${p}["']`, 'i'))?.[1];
  let name = meta('og:title') || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
  name = decode(name).replace(/\s*[|–-]\s*UT\.no\s*$/i, '').trim();
  const text = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  const grade = text.match(/\b(Enkel|Middels|Krevende|Ekspert)\s+(fottur|skitur|padletur|sykkeltur|turløype|klatretur|bretur)/i);
  const season = text.match(/Sesong:\s*([A-Za-zæøå]{3})[a-zæøå]*\.?\s*[-–]\s*([A-Za-zæøå]{3})/i);
  const km = text.match(/\b(\d+(?:[.,]\d+)?)\s*km\b/);
  const hours = text.match(/\b(\d+(?:[.,]\d+)?)\s*(?:t|timer)\b(?!\w)/);
  return {
    name,
    difficulty: grade?.[1]?.toLowerCase() || null,
    activity: grade?.[2]?.toLowerCase() || null,
    season_from: season ? MONTHS[season[1].toLowerCase()] || null : null,
    season_to: season ? MONTHS[season[2].toLowerCase()] || null : null,
    distance_km: km ? Number(km[1].replace(',', '.')) : null,
    duration_h: hours ? Number(hours[1].replace(',', '.')) : null,
  };
}

async function fetchTrip(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GodeNyheter/1.0; tursjekk)' }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  if (!isVerifiedSourceUrl(res.url)) return { ok: false, reason: 'videresendt til en ikke-godkjent side' };
  const info = parseTripPage(await res.text());
  if (!info.name || info.name.length < 3) return { ok: false, reason: 'fant ikke turnavn på siden' };
  return { ok: true, info };
}

/** Avgjør om en verifisert tur passer for en uorganisert fellestur. */
export function suitable(info) {
  if (info.difficulty && !['enkel', 'middels'].includes(info.difficulty)) return 'for krevende for en åpen fellestur';
  if (info.activity && !['fottur', 'skitur'].includes(info.activity)) return `${info.activity} krever eget utstyr/erfaring`;
  if (info.duration_h && info.duration_h > 4) return 'for lang for en åpen fellestur';
  return null;
}

/** Sjekker nye og gamle turer: nye blir godkjent hvis siden finnes og turen passer; gamle mister godkjenning hvis siden er borte. */
export async function verifySpots(db, regionId) {
  const stale = new Date(Date.now() - REVERIFY_DAYS * 864e5).toISOString();
  const { data, error } = await db.from('spots').select('id, url, approved, verified_at').eq('region', regionId);
  if (error) throw error;
  const todo = data.filter((s) => !s.verified_at || s.verified_at < stale);
  let approved = 0;
  for (const s of todo) {
    const patch = { verified_at: new Date().toISOString() };
    if (!s.url || !isVerifiedSourceUrl(s.url)) Object.assign(patch, { approved: false, note: 'Mangler lenke til godkjent turside (ut.no)' });
    else {
      const r = await fetchTrip(s.url).catch((e) => ({ ok: false, reason: e.message }));
      if (!r.ok) Object.assign(patch, { approved: false, note: `Kunne ikke verifiseres: ${r.reason}` });
      else {
        const why = suitable(r.info);
        Object.assign(patch, { ...r.info, approved: !why, note: why ? `Ikke brukt: ${why}` : 'Verifisert mot turside' });
        if (!why) approved++;
      }
    }
    const { error: e2 } = await db.from('spots').update(patch).eq('id', s.id);
    if (e2) console.warn(`Tursjekk ${s.url}: ${e2.message}`);
  }
  return { checked: todo.length, approved };
}

// ---------- Finn nye turer på ut.no (Claude med nettsøk) ----------
const FIND_SYSTEM = `Du finner turforslag på ut.no for en kommune/et område i Norge. Bruk nettsøk.
Krav: lettere eller middels fotturer (ev. skiturer) som passer for folk flest, 1–4 timer, med start i eller nær området.
Ta KUN med lenker du faktisk har sett i søkeresultatene, på formen https://ut.no/turforslag/<nummer>/… Aldri gjett eller lag lenker.
Svar til slutt KUN med JSON: {"urls":["https://ut.no/turforslag/…", …]}`;

export async function discoverSpots(db, ai, region) {
  const { data: spots, error } = await db.from('spots').select('url, approved').eq('region', region.id);
  if (error) throw error;
  if (spots.filter((s) => s.approved).length >= MIN_SPOTS) return 0;
  const have = new Set(spots.map((s) => s.url));
  const res = await ai.messages.create({
    model: SEARCH_MODEL, max_tokens: 2000, system: FIND_SYSTEM,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4, allowed_domains: Object.keys(VERIFIED_SOURCES) }],
    messages: [{ role: 'user', content: `Område: ${region.name}. Finn inntil 6 turforslag. Har allerede: ${[...have].join(', ') || 'ingen'}.` }],
  });
  // Ta bare med lenker som faktisk dukket opp i søkeresultatene (ikke noe modellen har skrevet selv)
  const seen = new Set();
  for (const b of res.content) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach((r) => r.url && seen.add(r.url.split('#')[0]));
  }
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let urls = [];
  try { urls = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).urls || []; } catch {}
  const fresh = [...new Set(urls)].filter((u) => isVerifiedSourceUrl(u) && seen.has(u) && !have.has(u)).slice(0, 6);
  if (!fresh.length) return 0;
  const rows = fresh.map((url) => ({ region: region.id, url, name: url, approved: false, source: 'ai-søk' }));
  const { error: e2 } = await db.from('spots').upsert(rows, { onConflict: 'region,url', ignoreDuplicates: true });
  if (e2) throw e2;
  return rows.length;  // verifySpots godkjenner dem (eller ikke) i samme kjøring
}

// ---------- Planlegg helgens fellestur ----------
const PLAN_SYSTEM = `Du velger turer til en uorganisert fellestur (ingen klokkeslett, ingen guide).
Du får været og en liste over verifiserte turer. Velg én hovedtur og inntil to alternativer (gjerne i ulike deler av området) som passer været.
Svar KUN med JSON: {"main": <indeks>, "alts": [<indeks>, …]}`;

const inSeason = (s, month) => !s.season_from || !s.season_to || (s.season_from <= s.season_to
  ? month >= s.season_from && month <= s.season_to : month >= s.season_from || month <= s.season_to);

export async function planEvents(db, ai, regions, weatherByRegion) {
  const today = ymd(new Date()), in7 = ymd(new Date(Date.now() + 7 * 864e5));
  let created = 0;
  for (const region of regions) {
    const days = weatherByRegion[region.id];
    if (!days?.length) continue;
    const weekend = days.filter((d) => d.date > today && d.date <= in7 && [0, 6].includes(dow(d.date)));
    if (!weekend.length) continue;
    const { data: existing, error } = await db.from('events').select('date').eq('region', region.id).in('date', weekend.map((d) => d.date));
    if (error) throw error;
    if (existing.length) continue;
    const fine = weekend.filter((d) => OUTDOOR.includes(kindOf(d)) || kindOf(d) === 'snø');
    if (!fine.length) continue;
    const day = fine.find((d) => OUTDOOR.includes(kindOf(d)) && dow(d.date) === 6) || fine.find((d) => OUTDOOR.includes(kindOf(d))) || fine[0];
    const kind = kindOf(day), month = Number(day.date.slice(5, 7));

    const { data: spots } = await db.from('spots').select('name, url, difficulty, activity, distance_km, duration_h, season_from, season_to')
      .eq('region', region.id).eq('approved', true);
    let candidates = (spots || []).filter((s) => isVerifiedSourceUrl(s.url) && inSeason(s, month))
      .filter((s) => kind === 'snø' ? s.activity === 'skitur' : s.activity !== 'skitur');
    const since = ymd(new Date(Date.now() - AVOID_DAYS * 864e5));
    const { data: recent } = await db.from('events').select('url').eq('region', region.id).gte('date', since);
    const used = new Set((recent || []).map((r) => r.url));
    const fresh = candidates.filter((s) => !used.has(s.url));
    if (fresh.length) candidates = fresh;
    if (!candidates.length) continue;

    let plan;
    try {
      const res = await ai.messages.create({ model: MODEL, max_tokens: 500, system: PLAN_SYSTEM, messages: [{ role: 'user', content: JSON.stringify({
        område: region.name, dag: day.date, vær: { type: kind, symbol: day.symbol, tmin: day.tmin, tmax: day.tmax, nedbør_mm: day.precip },
        turer: candidates.map((s, i) => ({ i, navn: s.name, grad: s.difficulty, km: s.distance_km, timer: s.duration_h })),
      }) }] });
      const t = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      plan = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    } catch (e) { console.warn(`Fellestur ${region.name}: Claude feilet (${e.message}) – bruker reserveplan`); }
    const ok = (i) => Number.isInteger(i) && i >= 0 && i < candidates.length;
    if (!plan || !ok(plan.main)) plan = { main: 0, alts: [1, 2], pitch: '' };
    const order = [plan.main, ...(plan.alts || []).filter((i) => ok(i) && i !== plan.main)].slice(0, 3);
    const pitch = String(plan.pitch || '').replace(/\b(kl\.?|klokka)\s*\d{1,2}([:.]\d{2})?/gi, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim().slice(0, 200);

    const rows = order.map((i, slot) => {
      const s = candidates[i];
      return { region: region.id, date: day.date, slot, kind, capacity: CAPACITY, spot_name: s.name, url: s.url, pitch,
        difficulty: s.difficulty, distance_km: s.distance_km, duration_h: s.duration_h };
    });
    const { error: e2 } = await db.from('events').insert(rows);
    if (e2) { console.warn(`Fellestur ${region.name}: ${e2.message}`); continue; }
    created++;
    console.log(`✓ Fellestur ${region.name} ${day.date}: ${rows.map((r) => r.spot_name).join(' / ')}`);
  }
  return created;
}
