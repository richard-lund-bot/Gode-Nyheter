// Åpen kasse: fører AI-kostnaden for hver kjøring inn i regnskapet (tabellen ledger), så den vises på nettsiden.
// Feil her stopper aldri innsamlingen – da blir bare denne kjøringen ikke ført.

// Anthropics listepriser i dollar per million tokens. Må oppdateres hvis modellen byttes eller prisene endres.
// «long» gjelder forespørsler der hele prompten er over så mange tokens.
const PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, long: { over: 100_000, in: 0.50, out: 2.50 } },
};
const CACHE_WRITE = 1.25, CACHE_READ = 0.1;   // andel av vanlig inn-pris (brukes bare hvis jobben får hurtiglager)
const SEARCH_USD = 10 / 1000;                  // nettsøk: 10 dollar per 1000 søk
const RATE_URL = 'https://data.norges-bank.no/api/data/EXR/B.USD.NOK.SP?format=sdmx-json&lastNObservations=1';

/** Prisen i dollar for ett svar fra Claude, regnet fra forbruket i svaret (res.usage). null = ukjent modell. */
export function costUsd(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const inp = usage.input_tokens || 0, write = usage.cache_creation_input_tokens || 0, read = usage.cache_read_input_tokens || 0;
  const rate = p.long && inp + write + read > p.long.over ? p.long : p;
  const tokens = (inp + write * CACHE_WRITE + read * CACHE_READ) * rate.in + (usage.output_tokens || 0) * rate.out;
  return tokens / 1e6 + (usage.server_tool_use?.web_search_requests || 0) * SEARCH_USD;
}

export function makeMeter() {
  const m = { usd: 0, calls: 0, unknown: new Set() };
  m.add = (model, usage) => {
    const c = costUsd(model, usage);
    if (c == null) { m.unknown.add(model); return; }
    m.usd += c; m.calls++;
  };
  return m;
}
/** Teller for hele kjøringen. Hvert kall til Claude legger forbruket sitt hit. */
export const meter = makeMeter();

/** Dagens dollarkurs fra Norges Bank (kroner per dollar). */
export async function usdNok() {
  const res = await fetch(RATE_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`Norges Bank svarte HTTP ${res.status}`); }
  const j = await res.json();
  const series = Object.values(j?.data?.dataSets?.[0]?.series || {})[0];
  const rate = Number(Object.values(series?.observations || {})[0]?.[0]);
  if (!(rate > 3 && rate < 30)) throw new Error('uventet kurs fra Norges Bank');
  return rate;
}

/** Legger kjøringens AI-kostnad til månedens linje i regnskapet. */
export async function bookAiCost(db, m = meter) {
  if (m.unknown.size) console.warn(`Åpen kasse: mangler pris for ${[...m.unknown].join(', ')}. Legg den inn i scripts/kasse.mjs – disse kallene er ikke ført.`);
  if (!m.calls) return;
  let rate = null;
  try { rate = await usdNok(); } catch (e) { console.warn(`Åpen kasse: fikk ikke dollarkursen (${e.message}) – bruker forrige kurs.`); }
  const { data, error } = await db.rpc('kasse_add_ai', { p_usd: Number(m.usd.toFixed(6)), p_rate: rate });
  if (error) { console.warn(`Åpen kasse: fikk ikke ført AI-kostnaden (${error.message}).`); return; }
  const now = `${(m.usd * 100).toFixed(2)} cent på ${m.calls} kall til Claude`;
  console.log(data == null ? `Åpen kasse: kjøringen brukte ${now}, men ble ikke ført (mangler dollarkurs).`
    : `Åpen kasse: kjøringen brukte ${now}. Ført hittil i måneden: ${data} kr.`);
}
