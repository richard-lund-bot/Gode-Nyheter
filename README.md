# Gode nyheter

Samler nyheter fra åpne RSS-feeder (lokalt, Norge og verden), lar Claude vurdere hvor positiv hver sak er, og viser bare de gode sakene i en PWA.

```
GitHub Action (hver halvtime)
  └─ scripts/fetch.mjs: RSS → fjerner duplikater → Claude Haiku (score 0–10, kategori, region, eget sammendrag) → Supabase
GitHub Pages
  └─ index.html: leser Supabase (bare score ≥ 6 er synlig, styrt av RLS) → faner, tema og filterstyrke
```

## Oppsett (ca. 20 min)

1. **Supabase:** Opprett et prosjekt, åpne SQL Editor og kjør `supabase/schema.sql`.
2. **Anthropic:** Lag en API-nøkkel på console.anthropic.com og **sett en månedlig utgiftsgrense** (Limits).
3. **GitHub:** Opprett et repo (gjerne offentlig, siden Actions-minutter da er gratis) og push filene.
   Legg inn tre hemmeligheter under Settings → Secrets and variables → Actions:
   - `SUPABASE_URL`: Project Settings → API → Project URL
   - `SUPABASE_SERVICE_KEY`: en **secret**-nøkkel (`sb_secret_…`) fra Project Settings → API Keys (**aldri** i nettsiden).
     Den gamle «service_role»-nøkkelen virker også, men Supabase slår av de gamle nøklene ved utgangen av 2026.
   - `ANTHROPIC_API_KEY`
4. **Første kjøring:** Gå til Actions → «Hent gode nyheter» → Run workflow. Loggen viser ✓/✗ per feed.
5. **Nettsiden:** Project URL og **publishable**-nøkkelen (`sb_publishable_…`) står øverst i `<script>` i `index.html`
   (allerede fylt inn for prosjektet `gode-nyheter`). Nøkkelen er laget for å ligge åpent; RLS styrer hva den får lese.
   Slå på GitHub Pages (Settings → Pages → Deploy from branch → main).

Uten nøkler viser `index.html` eksempelsaker, slik at du kan jobbe med designet.

## Justering

- **Kilder:** `sources.json`. `region` er et hint til AI-en. `aggregator: true` brukes for Google Nyheter-søk (henter ut riktig avisnavn). Sett `"enabled": false` for å slå av en kilde.
- **Hvor strengt:** Glidebryteren i appen (6–9). Under 6 er sakene aldri synlige utenfor databasen.
- **Vurderingene:** Prompten `SYSTEM` i `scripts/fetch.mjs`. Negative saker lagres også, så du kan sjekke om filteret bommer:
  `select score, tone, original_title from articles order by created_at desc limit 100;`
- **Kostnad:** `MAX_PER_RUN` (standard 120 saker per kjøring) er taket. 15 saker sendes per AI-kall.
- **Test lokalt uten nøkler:** `npm ci && npm run dry` henter feedene og viser hva som ville blitt klassifisert.

## Bilder og titler (v0.2)

- Bildet hentes fra feeden (`media:content`, `media:thumbnail`, `enclosure`). For gode saker uten bilde slås `og:image` opp på artikkelsiden (maks 40 per kjøring). Google Nyheter-saker har ingen bilder og får en illustrasjon i temafargen.
- Claude skriver en fengende tittel og et stikkord (`kicker`, f.eks. «Endelig:»), men titlene skal fortsatt være sanne. Originaltittelen ligger i `original_title`.
- Har du allerede tabellen fra v0.1, kjører du `schema.sql` på nytt. Den legger til de nye kolonnene.
- `SHOW_SOURCE_IMAGES = false` i `index.html` slår av kildebilder og bruker bare illustrasjoner.

## Humør, annonser og ekstra (v0.3)

- **Fargeaksenter** (uten tekst eller filter) regnes ut i nettsiden fra score, tone og tema: gul (score 9–10), blå (konstruktiv), rosa (Mennesker/Dyr) og grønn (resten). Fargen brukes på stikkord, kantstripe og tekstkort. Juster i `mood()`.
- **«Gledet meg» ☀**: Teller lagres i `glad_count` via RPC-funksjonen `glad()` (kjør `schema.sql` på nytt). Hver nettleser kan glede seg én gang per sak, men det håndheves bare lokalt. Legg på rate-limit (f.eks. Edge Function) før offentlig lansering.
- **lys- og værkortet** regner ut soloppgang og -nedgang lokalt for `HOME` i `index.html`. Ingen API.
- **Lesestreak** lagres bare i nettleseren (localStorage).
- **Annonser**: Listen `ADS` i `index.html` har to formater: `display` (kvadrat, VG-stil) og `native` (annonsørinnhold). Plasseringen styres av `#ad` i `PATTERN`. Merk alltid med «annonse».

## Idrett (v0.4)

- Egen seksjon «Idrett» i menyen (saker med `category = 'Idrett'`). Kategorien het tidligere «Sport». Har du gamle rader, kjør:
  `update articles set category = 'Idrett' where category = 'Sport';`
- Nye kilder: NRK Sport siste, BBC Sport og Google Nyheter-søk på Strømsgodset og Drammen-idrett.
- Prompten slipper gjennom seire, rekorder, fair play, breddeidrett og mestring (7–9), men holder tap, skader, skandaler og overgangsrykter nede (maks 5).

## Idrett på forsiden (v1.6)

- Forsiden viser bare **gode norske og lokale bragder**: lokal idrett med score 7 eller høyere (ikke fra områder langt unna deg) og norsk idrett med score 8 eller høyere. Internasjonal idrett vises ikke på forsiden.
- Høyst hver sjette sak på forsiden er idrett.
- Alt av idrett ligger fortsatt i seksjonen **Idrett**.
- Juster i `SPORT_FRONT` og `SPORT_FRONT_EVERY` øverst i `index.html`.
- Claude setter region «norge» for norske utøvere og lag også når saken kommer fra en utenlandsk kilde.

## Samme sak fra flere kilder + valg av kilder (v0.8)

- **Klynging:** Claude får med titlene på sakene fra siste 48 timer og sier om en ny sak gjelder *samme konkrete hendelse* (`same_as` / `same_as_i`). Slike saker får `story_id` = id-en til saken som leder historien. Nettsiden slår dem sammen til ett kort.
- **Logoer:** Favicon hentes fra kildens domene (`source_domain`) via DuckDuckGo sin ikontjeneste. Uten ikon vises initialer i en farget sirkel. Google Nyheter-saker får domenet til den egentlige avisa.
- **«Les hos»:** Store kort viser kildene som knapper med logo og navn. Små kort viser logoene etter hverandre og antall kilder. Trykker du på selve kortet, åpnes favorittavisa di hvis den har saken.
- **Kilder i menyen:** Slå hver kilde av og på, og stjernemerk favoritter. Lagres i nettleseren.
- `publisher` i `sources.json` slår sammen feeder fra samme utgiver (f.eks. alle NRK-feedene → «NRK»).
- Kjør `schema.sql` på nytt (nye kolonner `story_id` og `source_domain`).

## Vær og turtips i lys- og værkortet (v1.0)

- GitHub-jobben henter værvarsel fra **MET Norway** (Locationforecast 2.0) hver halvtime og lagrer en dagsoppsummering i tabellen `local_info`. Nettsiden kaller ikke MET direkte, fordi MET krever identifisering i User-Agent, og det kan ikke nettlesere sette.
- **Påkrevd:** Legg inn repo-variabelen `MET_CONTACT` (Settings → Secrets and variables → Actions → **Variables**), f.eks. e-postadressen din eller nettsidens adresse. Uten den hoppes været over.
- Valgfritt: `HOME_LAT` / `HOME_LON` for et annet sted (standard er Drammen). Husk også `HOME` i `index.html`.
- **Værtyper:** Hver dag klassifiseres som sol, oppholdsvær, klart og kaldt, varme, snø, regn, vind eller tåke (`kindOf()`).
- **Valg av dag:** fin helgedag > fin ukedag > første dag. Har nærmeste dag dårlig vær mens den fremhevede dagen er en annen, vises en ekstra linje med inne-tips for den dagen.
- **Forslag:** Listen `ACTIVITIES` i `index.html` har turer (ut.no), steder i Drammen (bibliotek, museum, badet) og hjemmeaktiviteter (bake, brettspill, ring noen …). Hvert forslag har `when` (værtyper), og eventuelt `months` (sesong) og `cold` (krever kuldegrader). Det første forslaget er alltid laget for akkurat den værtypen. Utvalget roterer daglig.
- **Titler** varierer per værtype (`TITLES`).
- Kildeangivelse «Værdata: MET Norway / yr.no» er påkrevd (CC BY 4.0) og står på kortet.
- Kjør `schema.sql` på nytt (ny tabell `local_info`).

## Områder og fellesturer «Bli med» (v1.3)

**Områder:** `regions.json` (navn og koordinater). Brukeren velger område i menyen, trykker «Finn nærmeste» (GPS i nettleseren) eller skriver **postnummer**. Postnummeret slås opp i Kartverkets åpne adresse-API (ws.geonorge.no) og gjøres om til nærmeste område. Bare området lagres, ikke posisjon eller postnummer.

**Bare verifiserte turer (ut.no):**
1. Har et område færre enn 6 godkjente turer, søker Claude etter turforslag med nettsøk som er **låst til ut.no** (`VERIFIED_SOURCES` i `scripts/events.mjs`). Bare lenker som faktisk dukket opp i søkeresultatene, tas med. Lenker modellen skriver selv, avvises. Det søkes høyst én gang i døgnet per område (`SEARCH_EVERY_H`), siden hvert nettsøk koster.
2. Jobben åpner hver turside selv og sjekker at den finnes. Fra siden hentes navn, vanskelighetsgrad, type, lengde, tid og sesong.
3. Turen godkjennes automatisk bare hvis den er en **enkel eller middels fottur eller skitur på maks 4 timer**. Krevende turer, padling, klatring osv. brukes ikke til åpne fellesturer. Grunnen står i `spots.note`.
4. Alle turer sjekkes på nytt hver 30. dag. Er siden borte, mister turen godkjenningen.
5. Vil du legge til en tur selv: sett inn en rad i `spots` med `region` og `url` (ut.no/turforslag/…). Den verifiseres i neste kjøring.

Krever at nettsøk er slått på for organisasjonen i Anthropic Console. Uten nettsøk brukes bare turene du legger inn selv (Drammen har fem fra start).

**Fellestur:** Ingen klokkeslett, bare en oppfordring («Lørdag er det fint turvær – bli med»). Turen planlegges for en fin helgedag, og skitur bare når det er snø. Turen må være i sesong, og samme tur brukes ikke igjen innen 21 dager. Claude velger hovedtur og inntil to alternativer og skriver oppfordringen. Eventuelle klokkeslett fjernes automatisk. Når en tur har 30 deltakere, foreslås alternativet, så folk spres utover. «Påminnelse» lager en heldagsoppføring i kalenderen.

**Bli med:** anonym teller (`join_event` / `leave_event`), ingen navn og ingen chat. Telleren bør få grense per IP før lansering.

## Lokalnyheter fra alle områder, nærmest først (v1.4)

- **Kilder:** Hvert område i `regions.json` får automatisk sitt eget Google Nyheter-søk (`news_query`, f.eks. `"Øvre Eiker" OR Hokksund OR Vestfossen`). NRK Buskerud og Buskerud-søket dekker hele fylket i tillegg. Nytt område = én linje i `regions.json`.
- **Område per sak:** Claude setter `area` (id fra `regions.json`) ut fra hvor saken faktisk skjer, ikke bare hvilket søk den kom fra. Ukjente verdier forkastes.
- **Prioritering** (`nearTier` / `NEAR_BOOST` i `index.html`):
  - ditt område: +4
  - nabo innen 20 km, eller generell Buskerud-sak: +1,5
  - innen 45 km: 0
  - lenger unna: −6
  - Seksjonen **Lokalt** sorterer først på nærhet, så på vanlig rangering.
- Lokalsaker viser områdenavnet (f.eks. «LIER») i stedet for «LOKALT».
- Kjør `schema.sql` på nytt (ny kolonne `area`).

## Tidslinje med tidsbonus + festet sak (v1.5)

**Rekkefølge på forsiden:**
1. **Festet sak** (hvis en er festet), gullkort øverst.
2. **Toppsak:** den beste saken nær deg siste døgn (kvalitet + nærhet).
3. **Tidslinje:** nyeste først, men med tidsbonus i timer (`BONUS_H` i `index.html`):
   - ditt område +3 t
   - nabo/Buskerud +1 t
   - innen 45 km 0
   - langt unna −6 t
   - score 9–10 +2 t

**Festet sak – tre veier inn, bare én om gangen, ligger øverst i 12 timer (`PIN_HOURS`, kan settes som repo-variabel):**
- **Claude** merker en sak `must_see` (krever score 10, skal være svært sjelden).
- **Leserne:** en sak får minst `GLAD_PIN` (standard 150) «Gledet meg» siste døgn. Sett gjerne som repo-variabel.
- **Manuelt:** sett `pinned_until` på en sak i Supabase (f.eks. `now() + interval '12 hours'`).

En ny festet sak kan ta over tidligst halvveis i perioden (6 timer). Kjør `schema.sql` på nytt (kolonnene `must_see` og `pinned_until`).

## Før siden blir offentlig

- [ ] Kjør i et par uker og les gjennom score-fordelingen. Juster prompten der den bommer.
- [ ] Legg til en Om-side: hva siden er, at AI sorterer og skriver sammendrag, og en kontaktadresse.
- [ ] **Bilderettigheter:** Pressebilder er opphavsrettsbeskyttet. Lenkede miniatyrbilder med kreditering er vanlig hos aggregatorer, men det er ikke risikofritt på en offentlig side. Vurder å spørre kildene, bruke lisensierte bilder (f.eks. Unsplash API per tema) eller slå av kildebilder.
- [ ] Sjekk vilkårene for hver kilde (særlig Google Nyheter og lokalaviser). Vis bare egne sammendrag med lenke, aldri kildens tekst eller bilder.
- [ ] Eget domene og personvernerklæring (siden har ingen sporing eller innlogging i dag).
- [ ] Vurder en «Rapporter feil»-knapp per sak, slik at feilvurderte saker kan fjernes.
