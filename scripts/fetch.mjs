// Gode nyheter – innsamling og AI-klassifisering
// Kjøres av GitHub Actions. Henter RSS, fjerner duplikater, klassifiserer nye saker
// med Claude og lagrer dem i Supabase.

import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { updateWeather } from './weather.mjs';
import { discoverSpots, verifySpots, planEvents } from './events.mjs';

// ---------- Innstillinger ----------
const MAX_PER_RUN   = Number(process.env.MAX_PER_RUN || 120); // kostnadstak per kjøring
const BATCH_SIZE    = 15;                                      // saker per AI-kall
const MAX_AGE_HOURS = 48;                                      // ignorer eldre saker
const KEEP_DAYS     = 30;                                      // slett eldre enn dette
const MODEL         = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const DRY_RUN       = process.env.DRY_RUN === '1';             // test uten DB/AI

const CATEGORIES = [
  'Samfunn', 'Natur og miljø', 'Vitenskap', 'Helse', 'Kultur',
  'Idrett', 'Arbeid og økonomi', 'Teknologi', 'Dyr', 'Mennesker',
];

// ---------- Oppsett ----------
const sourcesFile = process.env.SOURCES_FILE || new URL('../sources.json', import.meta.url);
const regionsFile = process.env.REGIONS_FILE || new URL('../regions.json', import.meta.url);
const REGIONS = JSON.parse(await readFile(regionsFile, 'utf8'));
// Faste kilder + ett lokalt nyhetssøk per område (Google Nyheter)
const sources = [
  ...JSON.parse(await readFile(sourcesFile, 'utf8')),
  ...REGIONS.map((r) => ({
    name: `Google Nyheter: ${r.name}`, region: 'lokalt', lang: 'no', aggregator: true, area: r.id,
    url: `https://news.google.com/rss/search?q=${encodeURIComponent(r.news_query || r.name)}&hl=no&gl=NO&ceid=NO:no`,
  })),
];
const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'GodeNyheter/0.1 (RSS-aggregator)' },
  customFields: {
    item: [
      'source',
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['content:encoded', 'contentEncoded'],
    ],
  },
});
const MAX_OG_LOOKUPS = 40; // maks antall artikkelsider vi slår opp bilde fra per kjøring
let ogLookups = 0;

const db = DRY_RUN ? null : createClient(
  requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_KEY'),
  { auth: { persistSession: false } },
);
const ai = DRY_RUN ? null : new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

function requireEnv(k) {
  if (!process.env[k]) { console.error(`Mangler miljøvariabel ${k}`); process.exit(1); }
  return process.env[k];
}

// ---------- Hjelpere ----------
const clean = (s = '') => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
const titleKey = (t) => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 90);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normUrl(u) {
  try {
    const x = new URL(u);
    [...x.searchParams.keys()].filter((k) => k.startsWith('utm_')).forEach((k) => x.searchParams.delete(k));
    x.hash = '';
    return x.toString();
  } catch { return u; }
}

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

// ---------- Bilder ----------
const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);

function pickImage(it) {
  const cands = [];
  const push = (url, w = 0) => { if (isHttps(url)) cands.push({ url, w: Number(w) || 0 }); };
  if (it.enclosure?.url && (!it.enclosure.type || it.enclosure.type.startsWith('image'))) push(it.enclosure.url, 9999);
  for (const m of it.mediaContent || []) {
    const a = m?.$ || {};
    if (!a.medium || a.medium === 'image' || (a.type || '').startsWith('image')) push(a.url, a.width);
  }
  for (const m of it.mediaThumbnail || []) push(m?.$?.url, m?.$?.width);
  const html = it.contentEncoded || it.content || '';
  const img = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (img) push(img[1], 1);
  cands.sort((a, b) => b.w - a.w);
  return cands[0]?.url || null;
}

async function fetchOgImage(pageUrl) {
  try {
    const res = await fetch(pageUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GodeNyheter/0.2; link preview)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 300000);
    const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
    if (!m) return null;
    const abs = new URL(m[1].replace(/&amp;/g, '&'), res.url).toString();
    return isHttps(abs) ? abs : null;
  } catch { return null; }
}

// Fyll inn bilde fra artikkelsiden (og:image) for gode saker som mangler bilde i feeden
async function enrichImages(rows) {
  const todo = rows.filter((r) => !r.image_url && r.score >= 7 && !r._aggregator);
  for (const r of todo) {
    if (ogLookups >= MAX_OG_LOOKUPS) break;
    ogLookups++;
    r.image_url = await fetchOgImage(r.url);
  }
  rows.forEach((r) => delete r._aggregator);
}

// ---------- 1. Hent feeder ----------
async function collect() {
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600e3;
  const out = [];
  const results = await Promise.allSettled(
    sources.filter((s) => s.enabled !== false).map(async (s) => {
      const feed = await parser.parseURL(s.url);
      let n = 0;
      for (const it of feed.items || []) {
        if (!it.link || !it.title) continue;
        const pub = it.isoDate ? Date.parse(it.isoDate) : Date.now();
        if (pub < cutoff) continue;

        let title = it.title.trim();
        let sourceName = s.publisher || s.name;
        let domain = host(it.link);
        if (s.aggregator) {
          // Google Nyheter: «Tittel - Avisnavn» → bruk egentlig kilde og dens domene
          const src = typeof it.source === 'string' ? it.source : it.source?._;
          if (src) {
            sourceName = src.trim();
            title = title.replace(new RegExp(`\\s+-\\s+${escapeRe(sourceName)}$`), '');
          }
          domain = host(it.source?.$?.url);
        }
        out.push({
          url: normUrl(it.link),
          source: sourceName,
          source_domain: domain,
          lang: s.lang,
          region_hint: s.region,
          title,
          snippet: clean(it.contentSnippet || it.content || it.summary || ''),
          image: pickImage(it),
          aggregator: !!s.aggregator,
          area_hint: s.area || null,
          published_at: new Date(pub).toISOString(),
        });
        n++;
      }
      return `${s.name}: ${n}`;
    }),
  );
  results.forEach((r, i) => {
    const name = sources.filter((s) => s.enabled !== false)[i].name;
    if (r.status === 'fulfilled') console.log(`✓ ${r.value}`);
    else console.warn(`✗ ${name}: ${r.reason?.message || r.reason}`);
  });
  return out;
}

// ---------- 2. Fjern duplikater ----------
async function dedupe(items) {
  const seenUrl = new Set();
  const seenTitle = new Set();

  if (db) {
    const since = new Date(Date.now() - 4 * 864e5).toISOString();
    const { data, error } = await db.from('articles')
      .select('url, original_title, source').gte('created_at', since).limit(10000);
    if (error) throw error;
    data.forEach((r) => { seenUrl.add(r.url); seenTitle.add(`${r.source}|${titleKey(r.original_title)}`); });
  }

  const fresh = [];
  for (const it of items) {
    const tk = `${it.source}|${titleKey(it.title)}`;
    if (seenUrl.has(it.url) || seenTitle.has(tk)) continue;
    seenUrl.add(it.url); seenTitle.add(tk);
    fresh.push(it);
  }
  // Nyeste først, og maks MAX_PER_RUN (kostnadstak)
  fresh.sort((a, b) => b.published_at.localeCompare(a.published_at));
  return fresh.slice(0, MAX_PER_RUN);
}

// ---------- 3. Klassifiser med Claude ----------
const SYSTEM = `Du er redaktør for en norsk nettside med bare gode nyheter. Du vurderer nyhetssaker ut fra tittel og ingress.

For hver sak, gi:
- score: heltall 0–10 for hvor oppløftende saken er for en vanlig leser.
  9–10: tydelig gledelig (redning, gjennombrudd, rekord i noe godt, stor vennlighet, natur som kommer tilbake)
  7–8:  positiv eller konstruktiv (en løsning på et problem, fremgang, fellesskap, gode tiltak)
  5–6:  nøytral eller blandet
  0–4:  negativ (krig, kriminalitet, ulykker, dødsfall, katastrofer, konflikt, politisk krangel, kutt, oppsigelser)
  Viktig: Vurder kjernen i saken, ikke enkeltord. «Ny behandling gir håp for kreftpasienter» er positiv.
  «Overlevde ulykken» er fortsatt en ulykkessak (maks 5) med mindre redningen er selve historien.
  Klikkagn, reklame, børstall og saker uten innhold: maks 6.
  IDRETT: Seire, medaljer, rekorder, comebacks, fair play, lokale lag og utøvere som lykkes, breddeidrett, dugnad i klubben,
  barn og unge som mestrer og store publikumsfester: 7–9 (sett category "Idrett"). Tap, skader, skandaler, doping, sparkede
  trenere, overgangsrykter, bøter og tabellstatus uten historie: maks 5. Et rent resultat («2–1 mot X») uten mer innhold: 6.
- tone: "positiv" | "konstruktiv" | "nøytral" | "negativ"
- category: én av ${CATEGORIES.map((c) => `"${c}"`).join(', ')}
- region: "lokalt", "norge" eller "verden". Bruk hintet, men overstyr hvis innholdet tydelig sier noe annet.
- area: hvis saken handler om et sted i ett av disse lokale områdene, oppgi id-en, ellers null:
  ${REGIONS.map((r) => `"${r.id}" (${r.name})`).join(', ')}.
  Bruk område_hint som utgangspunkt, men velg ut fra hvor saken faktisk skjer (et søk på «Lier» kan gi en sak fra Drammen).
  Er area satt, skal region være "lokalt".
- kicker: 1–2 konkrete ord foran tittelen i avisstil: sted, tema eller hovedperson (f.eks. "Lier:", "Forskning:", "Ski-VM:").
  Ikke følelsesord eller vurderinger ("Hjertevarmt:", "Endelig:", "Gladnyhet:", "Rørende:"). Tom streng hvis ingenting passer.
- title_no: fengende avistittel på norsk bokmål, maks 70 tegn, som får folk til å ville lese, men den skal være SANN.
  Bruk aktive verb, konkrete detaljer, tall og steder når kilden har dem. Ingen spørsmålstitler, ingen «Du vil ikke tro …»,
  ingen overdrivelser utover det kilden sier, og ikke gjenta kickerordet. Utenlandske saker skrives som norske titler.
  Unngå klisjeer og pyntord: «hjertevarm», «rørende», «magisk», «solskinnshistorie», «gladsak», «varmer hjertet», «til tårer».
  Skriv nøkternt og konkret – la fakta gjøre saken positiv.
- summary_no: ditt EGET sammendrag på bokmål, én setning, maks 25 ord. Ikke kopier ingressen ordrett. Ikke overdriv utover det kilden sier.
  Samme regel om klisjeer som for tittelen.

- must_see: true KUN for helt eksepsjonelle, gledelige saker med bred appell som nesten alle vil bli glade av å høre
  (f.eks. et bekreftet medisinsk gjennombrudd, en dyreart reddet fra utryddelse, savnede barn funnet i god behold).
  Krever score 10. Skal være svært sjelden – omtrent én av hundre saker. Ellers false.
- same_as: Du får også «eksisterende»: saker vi allerede har (id + tittel). Gjelder den nye saken NØYAKTIG samme konkrete
  hendelse som en eksisterende (samme person/lag/sted/funn – ikke bare samme tema), sett same_as til den id-en, ellers null.
- same_as_i: Gjelder den samme hendelse som en TIDLIGERE sak i «nye» (lavere i), sett same_as_i til den i-en, ellers null.

Svar KUN med en JSON-liste, samme rekkefølge og "i" som i «nye»:
[{"i":0,"score":8,"tone":"positiv","category":"Natur og miljø","region":"lokalt","area":"drammen","kicker":"Endelig:","title_no":"…","summary_no":"…","must_see":false,"same_as":null,"same_as_i":null}]`;

async function classifyBatch(batch, leads) {
  const payload = {
    nye: batch.map((it, i) => ({ i, kilde: it.source, språk: it.lang, region_hint: it.region_hint, område_hint: it.area_hint, tittel: it.title, ingress: it.snippet })),
    eksisterende: [...leads].slice(0, 150).map(([id, t]) => ({ id, tittel: t })),
  };
  const res = await ai.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  const parsed = JSON.parse(json);
  return parsed.map((r) => {
    const it = batch[r.i];
    if (!it) return null;
    return {
      url: it.url,
      source: it.source,
      source_lang: it.lang,
      original_title: it.title,
      kicker: String(r.kicker || '').slice(0, 30),
      title_no: String(r.title_no || it.title).slice(0, 300),
      image_url: it.image,
      _aggregator: it.aggregator,
      summary_no: String(r.summary_no || '').slice(0, 400),
      score: Math.max(0, Math.min(10, Math.round(Number(r.score) || 0))),
      tone: r.tone,
      category: CATEGORIES.includes(r.category) ? r.category : 'Samfunn',
      area: REGIONS.some((x) => x.id === r.area) ? r.area : null,
      must_see: r.must_see === true && Number(r.score) >= 10,
      region: REGIONS.some((x) => x.id === r.area) ? 'lokalt' : (['lokalt', 'norge', 'verden'].includes(r.region) ? r.region : it.region_hint),
      published_at: it.published_at,
      source_domain: it.source_domain,
      _i: r.i,
      _same_as: leads.has(Number(r.same_as)) ? Number(r.same_as) : null,
      _same_as_i: Number.isInteger(r.same_as_i) && r.same_as_i >= 0 && r.same_as_i < r.i ? r.same_as_i : null,
    };
  }).filter(Boolean).sort((a, b) => a._i - b._i);
}

// ---------- Kjør ----------
if (!DRY_RUN) {
  // Vær per område, forslag til nye turmål (må godkjennes) og helgens fellesturer. Feil her stopper ikke nyhetene.
  try {
    const regions = REGIONS;
    const weather = await updateWeather(db, regions, process.env.MET_CONTACT);
    for (const r of regions) {
      try {
        const found = await discoverSpots(db, ai, r);
        const { checked, approved } = await verifySpots(db, r.id);
        if (found || checked) console.log(`✓ Turer ${r.name}: ${found} nye funnet på ut.no, ${checked} sjekket, ${approved} godkjent`);
      } catch (e) { console.warn(`Turer ${r.name}: ${e.message}`); }
    }
    await planEvents(db, ai, regions, weather);
  } catch (e) { console.warn(`Vær/fellestur feilet: ${e.message}`); }
}

const all = await collect();
const fresh = await dedupe(all);
console.log(`\nHentet ${all.length} saker, ${fresh.length} nye å klassifisere.`);

if (DRY_RUN) {
  console.table(fresh.slice(0, 15).map((f) => ({ kilde: f.source, region: f.region_hint, bilde: f.image ? 'ja' : '–', tittel: f.title.slice(0, 60) })));
  process.exit(0);
}

// ---------- «Dagens solskinnssak» ----------
const PIN_HOURS = Number(process.env.PIN_HOURS || 12);   // hvor lenge en solskinnssak ligger øverst
const PIN_MIN_GAP_HOURS = PIN_HOURS / 2;                // en ny kan ta over tidligst så lenge etter at forrige ble festet
const GLAD_PIN = Number(process.env.GLAD_PIN || 150); // så mange «Gledet meg» siste døgn gjør en sak til solskinnssak
async function activePin() {
  const { data } = await db.from('articles').select('id, pinned_until').gt('pinned_until', new Date().toISOString())
    .order('pinned_until', { ascending: false }).limit(1);
  return data?.[0] || null;
}
async function pin(id, why) {
  const until = new Date(Date.now() + PIN_HOURS * 3600e3).toISOString();
  const { error } = await db.from('articles').update({ pinned_until: until }).eq('id', id);
  if (!error) console.log(`☀ Ny solskinnssak (${why}): ${id} til ${until}`);
}
// En ny kan ta over hvis ingen er festet, eller den festede har ligget der i minst PIN_MIN_GAP_HOURS
const canPin = (cur) => !cur || new Date(cur.pinned_until).getTime() - Date.now() < (PIN_HOURS - PIN_MIN_GAP_HOURS) * 3600e3;

// Saker fra siste 48 t som «leder» en historie – nye saker om samme hendelse knyttes til disse (story_id)
async function loadLeads() {
  const since = new Date(Date.now() - 48 * 3600e3).toISOString();
  const { data, error } = await db.from('articles').select('id, title_no, story_id')
    .gte('created_at', since).gte('score', 6).order('created_at', { ascending: false }).limit(400);
  if (error) throw error;
  return new Map(data.filter((r) => !r.story_id || r.story_id === r.id).map((r) => [r.id, r.title_no]));
}

let leads = await loadLeads();
let saved = 0, good = 0, failed = 0, clustered = 0;
for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
  const batch = fresh.slice(i, i + BATCH_SIZE);
  try {
    const rows = await classifyBatch(batch, leads);
    await enrichImages(rows);
    for (const r of rows) if (r._same_as) { r.story_id = r._same_as; clustered++; }
    const insertRows = rows.map(({ _i, _same_as, _same_as_i, ...rest }) => rest);
    const { data: ins, error } = await db.from('articles')
      .upsert(insertRows, { onConflict: 'url', ignoreDuplicates: true }).select('id, url, story_id, score, title_no');
    if (error) throw error;
    // Knytt saker som gjelder samme hendelse innad i batchen
    const byI = new Map(rows.map((r) => [r._i, ins.find((x) => x.url === r.url)]).filter(([, v]) => v));
    for (const r of rows) {
      if (r._same_as_i == null) continue;
      const me = byI.get(r._i), target = byI.get(r._same_as_i);
      if (!me || !target) continue;
      const sid = target.story_id || target.id;
      const { error: uErr } = await db.from('articles').update({ story_id: sid }).eq('id', me.id);
      if (!uErr) { me.story_id = sid; clustered++; }
    }
    // Claude har merket en sak som helt eksepsjonell → solskinnssak (hvis det er plass)
    const star = rows.filter((r) => r.must_see).map((r) => ins.find((x) => x.url === r.url)).find((m) => m && !m.story_id);
    if (star && canPin(await activePin())) await pin(star.id, 'Claude: must_see');
    const newLeads = ins.filter((m) => !m.story_id && m.score >= 6).map((m) => [m.id, m.title_no]);
    leads = new Map([...newLeads, ...leads]);
    saved += rows.length;
    good += rows.filter((r) => r.score >= 7).length;
  } catch (e) {
    failed += batch.length;
    console.warn(`Batch ${i / BATCH_SIZE + 1} feilet: ${e.message}`);
  }
}

// Leserne har bestemt: veldig mange «Gledet meg» siste døgn → solskinnssak
try {
  if (canPin(await activePin())) {
    const { data: top } = await db.from('articles').select('id, glad_count')
      .gte('created_at', new Date(Date.now() - 864e5).toISOString()).is('pinned_until', null)
      .order('glad_count', { ascending: false }).limit(1);
    if (top?.[0]?.glad_count >= GLAD_PIN) await pin(top[0].id, `${top[0].glad_count} «Gledet meg»`);
  }
} catch (e) { console.warn(`Solskinnssak: ${e.message}`); }

const { error: delErr } = await db.from('articles')
  .delete().lt('created_at', new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
if (delErr) console.warn(`Opprydding feilet: ${delErr.message}`);

console.log(`Lagret ${saved} (${good} gode, score ≥ 7, ${clustered} knyttet til samme sak fra andre kilder). Feilet: ${failed}.`);
if (failed && !saved) process.exit(1);
