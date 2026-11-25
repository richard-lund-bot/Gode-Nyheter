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

- Bildet hentes fra feeden (`media:content`, `media:thumbnail`, `enclosure`). For saker uten bilde slås `og:image` opp på artikkelsiden – også for saker fra Google Nyheter (se v1.7).
- Claude skriver en kort, fengende tittel og et stikkord (`kicker`, f.eks. «Lier:»), men titlene skal fortsatt være sanne. Originaltittelen ligger i `original_title`.
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

## Topplinje med faner og Åpen kasse (v2.0)

**Topplinjen** er én linje: logo, faner, været, en gul knapp som viser potten, og menyen.

- **Pott-knappen** har alltid plass og fører til Åpen kasse.
- **Fanene** (Forsiden, Lokalt, Norge, Verden, Idrett) vises bare hvis de får plass i sin helhet mellom logoen og pott-knappen. På en vanlig telefon blir det ingen eller én, på PC alle. Resten ligger i menyen. `fitTabs()` i `index.html` styrer dette.
- **Været** der leseren bor lenker til yr for akkurat det stedet. På PC står det i topplinjen. På mobil står det i en smal stripe under, bare på forsiden, sammen med «Bytt sted», som åpner menyen på «Mitt område».
- **Stedet** leseren velger, huskes i nettleseren. Det er ingen innlogging.

**Åpen kasse** (`#kasse`) viser alt som kommer inn og går ut, og hvem som får overskuddet. Den leser fire tabeller i databasen:

| Tabell | Innhold | Hvem ser den |
|---|---|---|
| `ledger` | Regnskapet: én linje per inntekt (`inn`), kostnad (`ut`) eller utbetaling til et lag (`utbetalt`) | Alle |
| `clubs` | Påmeldte lag. Nye står som `pending` og vises først når `status` er `approved` | Alle ser de godkjente |
| `club_contacts` | E-post og organisasjonsnummer til lagene | Bare eieren |
| `draws` | Trekninger: måned, pott, vinner og hvilke lag som var med | Alle |

Slik gjør du det vanligste, i Supabase → Table Editor:

- **Føre en inntekt eller kostnad:** `ledger` → Insert row. Fyll ut `kind` (`inn` eller `ut`), `title`, `amount` (kroner), `booked_on` (dato) og gjerne `note`.
- **Godkjenne et lag:** `clubs` → sett `status` til `approved` (eller `rejected`). Kontaktinformasjonen står i `club_contacts`.
- **Trekke en vinner:** SQL Editor → `select private.run_monthly_draw();`. Funksjonen trekker blant godkjente lag som ikke har vunnet de siste tolv månedene, og fører utbetalingen i regnskapet. Den gjør ingenting hvis potten er under 500 kr, eller hvis måneden allerede er trukket. Den står ikke på tidsplan.
- **Merke en utbetaling som gjort:** `draws` → fyll ut `paid_on` og eventuelt `receipt_url` (må begynne med `https://`).

**AI-kostnaden føres av seg selv.** Innsamlingsjobben regner ut hva hver kjøring kostet (tokens og nettsøk, etter prislista i `scripts/kasse.mjs`), henter dollarkursen fra Norges Bank og legger beløpet til månedens linje «Kunstig intelligens». Det er et beregnet tall. Når fakturaen kommer, kan du rette beløpet på linja for en avsluttet måned. Jobben rører bare inneværende måned. Bytter du modell, må prisen legges inn i `scripts/kasse.mjs`, ellers blir kallene ikke ført (jobben sier fra i loggen).

Reglene som står på siden, ligger øverst i `index.html` (`KASSE_MIN_POT`, `KASSE_PAUSE_MND`, `KASSE_GRATIS`) og i lista i `renderKasse()`. Endrer du minstegrensen, må den også sendes med til trekningen: `select private.run_monthly_draw(1000);`.

## Store overskrifter og fast lyst utseende (v1.9)

- **Overskrifter som på en avisforside.** Sakenes overskrifter settes i en kraftig avisskrift (Source Serif 4 Black, ligger i `fonts/` og følger med siden – lisens i `fonts/OFL.txt`). I de store kortene deles tittelen på noen få linjer, og hver linje strekkes så den fyller kortbredden. Det gjør `fitTitles()` i `index.html`; innstillingene står i `FIT` (høyst antall linjer, ønsket størrelse og største størrelse per korttype). Blir en tittel for lang til å se bra ut, brytes den som vanlig tekst.
- **Stikkordet står på egen linje** over tittelen, i sakens farge.
- **Kortere titler.** Claude skriver nå korte forsidetitler (helst 3–7 ord, maks 45 tegn) i stedet for titler på opptil 70 tegn. Kravet om at tittelen skal være sann, står som før. Saker som allerede ligger i databasen, beholder den gamle tittelen til de går ut av forsiden etter noen dager.
- **Større bilder og tekst.** Hovedsaken har bildet øverst i full bredde på alle skjermer, og ingress og tidslinje har større skrift.
- **Aldri automatisk mørk modus.** Siden er lys for alle, også når telefonen står i mørk modus. Mørkt utseende velges i menyen (Lyst / Mørkt), og valget huskes. De som hadde «Auto» fra før, får lyst.

## Databasen starter jobben (v1.8)

GitHubs egen tidsplan viste seg upålitelig: jobben ble startet én gang på elleve timer, selv om den er satt til hver halvtime. Derfor ber databasen GitHub om å kjøre «Hent gode nyheter» kl. :22 og :52 hver time. GitHubs tidsplan (:07 og :37) står som reserve.

- **Oppsett:** `pg_cron` kjører `private.start_news_job()`, som sender en forespørsel til GitHubs API med `pg_net`. Se nederst i `schema.sql`.
- **Nøkkel:** en fine-grained GitHub-nøkkel med tilgang til bare dette repoet og rettigheten *Actions: Read and write*. Den ligger kryptert i Supabase Vault under navnet `github_dispatch_token`. Slike nøkler varer høyst ett år og må da byttes i Vault.
- **Uten nøkkel** gjør jobben ingenting, og siden oppdateres bare når GitHub selv starter jobben.
- **Sjekk at det virker:** `select * from cron.job_run_details order by start_time desc limit 5;` viser når databasen prøvde, og `select status_code, created from net._http_response order by created desc limit 5;` viser svaret fra GitHub (204 betyr at jobben ble startet, 401 at nøkkelen er feil eller utløpt).
- **Skru av:** `select cron.unschedule('gode-nyheter-hent');`

## Bilder, pluss-saker og avisrekkefølge (v1.7)

**Bilder og egentlig lenke.** Google Nyheter gir bare en omvei-lenke uten bilde. For saker som skal vises (score 6 eller høyere) finner jobben avisas egen adresse bak lenken, åpner artikkelsiden og henter bildet (`og:image`). Nettsiden lenker rett til avisa. Høyst `MAX_LOOKUPS` sider (standard 60) åpnes per kjøring; resten tas i neste kjøring. Svarer ikke Google, lagres saken uten bilde og prøves igjen senere.

**Saker uten bilde** får aldri en tom bildeflate. De vises som rene overskrifter, samlet i blokker på inntil fire (`LINES_MAX` i `index.html`), eller som tekstkort der mønsteret har en tekstplass. Har flere aviser samme sak, lånes bildet fra den som har et.

**Pluss-saker.** Jobben leser merkingen avisene selv bruker overfor Google og Facebook (`isAccessibleForFree` i schema.org og `article:content_tier`) og lagrer den i `paywall` (true = pluss, false = åpen, null = ukjent). Nettsiden viser et gult **+** ved hver avis som krever abonnement. Når flere aviser har samme sak, vises alle med hvert sitt merke, og kortet åpner en åpen utgave foran en pluss-utgave – med mindre du har satt din egen rekkefølge.

**Aviser i menyen.** Lista ligger i en sammenleggbar del. Bryteren skjuler en avis helt. Dra i håndtaket (eller bruk piltastene) for å endre rekkefølgen: avisa øverst åpnes først når flere har samme sak. Rekkefølgen lagres i nettleseren.

**Feilsøking.** Start jobben manuelt med «debug» slått på for å se hva den finner på hver artikkelside.

Kjør `schema.sql` på nytt (kolonnene `direct_url`, `paywall` og `enriched_at`).

## Idrett på forsiden (v1.6)

- Forsiden viser bare **gode norske og lokale bragder**: lokal idrett med score 7 eller høyere (ikke fra områder langt unna deg) og norsk idrett med score 8 eller høyere. Internasjonal idrett vises ikke på forsiden.
- Høyst hver sjette sak på forsiden er idrett.
- Alt av idrett ligger fortsatt i seksjonen **Idrett**.
- Juster i `SPORT_FRONT` og `SPORT_FRONT_EVERY` øverst i `index.html`.
- Claude setter region «norge» for norske utøvere og lag også når saken kommer fra en utenlandsk kilde.

## Samme sak fra flere kilder + valg av kilder (v0.8)

- **Klynging:** Claude får med titlene på sakene fra siste 48 timer og sier om en ny sak gjelder *samme konkrete hendelse* (`same_as` / `same_as_i`). Slike saker får `story_id` = id-en til saken som leder historien. Nettsiden slår dem sammen til ett kort.
- **Logoer:** Favicon hentes fra kildens domene (`source_domain`) via DuckDuckGo sin ikontjeneste. Uten ikon vises initialer i en farget sirkel. Google Nyheter-saker får domenet til den egentlige avisa.
- **«Les hos»:** Store kort viser avisene som knapper med logo og navn. Små kort viser logoene etter hverandre og antall aviser. Trykker du på selve kortet, åpnes avisa du har satt øverst, hvis den har saken.
- **Aviser i menyen:** Slå hver avis av og på, og dra dem i ønsket rekkefølge (se v1.7). Lagres i nettleseren.
- `publisher` i `sources.json` slår sammen feeder fra samme utgiver (f.eks. alle NRK-feedene → «NRK»).
- Kjør `schema.sql` på nytt (nye kolonner `story_id` og `source_domain`).

## Vær og turtips i lys- og værkortet (v1.0)

- GitHub-jobben henter værvarsel fra **MET Norway** (Locationforecast 2.0) hver halvtime og lagrer en dagsoppsummering i tabellen `local_info`. Nettsiden kaller ikke MET direkte, fordi MET krever identifisering i User-Agent, og det kan ikke nettlesere sette.
- **Påkrevd:** Legg inn `MET_CONTACT` (Settings → Secrets and variables → Actions), f.eks. e-postadressen din eller nettsidens adresse. Den kan ligge under **Variables** eller **Secrets**; jobben leser begge. Uten den hoppes været over.
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
