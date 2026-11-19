// Værvarsel fra MET Norway (Locationforecast 2.0), oppsummert per dag for nettsidens «Lysglimt».
// Data: MET Norway, CC BY 4.0. Vilkår: https://api.met.no/doc/TermsOfService (User-Agent med kontaktinfo er påkrevd).

const TZ = 'Europe/Oslo';
const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});
const local = (iso) => {
  const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};

/** Gjør MET-svar om til [{date, tmin, tmax, precip, wind, symbol}] for dagtid (08–18 lokal tid). */
export function summarizeForecast(json, maxDays = 7) {
  const days = new Map();
  for (const t of json?.properties?.timeseries || []) {
    const { date, hour } = local(t.time);
    const d = days.get(date) || { date, tmin: Infinity, tmax: -Infinity, precip: 0, wind: 0, symbol: null, _sd: 99, _p1: false };
    const det = t.data?.instant?.details || {};
    if (hour >= 8 && hour <= 18) {
      if (det.air_temperature != null) { d.tmin = Math.min(d.tmin, det.air_temperature); d.tmax = Math.max(d.tmax, det.air_temperature); }
      if (det.wind_speed != null) d.wind = Math.max(d.wind, det.wind_speed);
    }
    const n1 = t.data?.next_1_hours, n6 = t.data?.next_6_hours;
    // Nedbør: timesverdier på dagtid, ellers 6-timersverdier som dekker dagtid
    if (n1 && hour >= 8 && hour <= 18) { d.precip += n1.details?.precipitation_amount || 0; d._p1 = true; }
    else if (!n1 && n6 && !d._p1 && hour >= 6 && hour <= 13) d.precip += n6.details?.precipitation_amount || 0;
    // Symbol: det som ligger nærmest kl. 13
    const sym = n1?.summary?.symbol_code || n6?.summary?.symbol_code;
    if (sym && Math.abs(hour - 13) < d._sd) { d.symbol = sym; d._sd = Math.abs(hour - 13); }
    days.set(date, d);
  }
  return [...days.values()]
    .filter((d) => d.symbol && Number.isFinite(d.tmax))
    .slice(0, maxDays)
    .map(({ _sd, _p1, ...d }) => ({ ...d, tmin: Math.round(d.tmin), tmax: Math.round(d.tmax), precip: Math.round(d.precip * 10) / 10, wind: Math.round(d.wind) }));
}

// Samme værtyper som nettsiden bruker
export function kindOf(d) {
  if (/snow/.test(d.symbol)) return 'snø';
  if (/rain|sleet|thunder/.test(d.symbol) || d.precip >= 1) return 'regn';
  if (d.wind >= 10) return 'vind';
  if (/fog/.test(d.symbol)) return 'tåke';
  if (/clearsky|fair/.test(d.symbol)) return d.tmax >= 22 ? 'varme' : d.tmax <= -3 ? 'kulde' : 'sol';
  return 'sky';
}
export const OUTDOOR = ['sol', 'sky', 'kulde', 'varme'];

export async function fetchForecast({ lat, lon, contact }) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${Number(lat).toFixed(3)}&lon=${Number(lon).toFixed(3)}`;
  const res = await fetch(url, { headers: { 'User-Agent': `GodeNyheter/1.0 ${contact}` }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`MET svarte ${res.status}`);
  return summarizeForecast(await res.json());
}

/** Henter varsel for hvert område og lagrer i local_info (key = 'weather:<område>'). Returnerer {område: dager}. */
export async function updateWeather(db, regions, contact) {
  if (!contact) { console.warn('Vær: MET_CONTACT mangler – hopper over vær og fellesturer (se README).'); return {}; }
  const out = {};
  for (const r of regions) {
    try {
      const days = await fetchForecast({ lat: r.lat, lon: r.lon, contact });
      const { error } = await db.from('local_info').upsert({ key: `weather:${r.id}`, data: { lat: r.lat, lon: r.lon, days }, updated_at: new Date().toISOString() });
      if (error) throw error;
      out[r.id] = days;
    } catch (e) { console.warn(`Vær ${r.name}: ${e.message}`); }
  }
  console.log(`✓ Vær: ${Object.keys(out).length}/${regions.length} områder`);
  return out;
}
