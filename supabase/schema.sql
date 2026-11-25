-- Gode nyheter – databaseskjema
-- Kjør i Supabase: SQL Editor → New query → lim inn → Run

create table if not exists public.articles (
  id             bigint generated always as identity primary key,
  url            text        not null unique,
  source         text        not null,
  source_lang    text,
  original_title text        not null,
  title_no       text,          -- norsk tittel (oversatt hvis kilden er utenlandsk)
  summary_no     text,          -- AI-skrevet sammendrag, én setning (ikke kildens tekst)
  score          smallint,      -- 0–10, hvor positiv/oppløftende saken er
  tone           text,          -- positiv | konstruktiv | nøytral | negativ
  category       text,
  region         text,          -- lokalt | norge | verden
  published_at   timestamptz,
  created_at     timestamptz not null default now()
);

-- v1.5: «Dagens solskinnssak» – festes øverst en periode
alter table public.articles add column if not exists must_see     boolean not null default false;  -- Claude: helt eksepsjonell
alter table public.articles add column if not exists pinned_until timestamptz;                       -- satt av jobben eller manuelt
create index if not exists articles_pinned_idx on public.articles (pinned_until);

-- v1.7: oppslag på artikkelsiden – avisas egen adresse, pluss-merking og når vi sist sjekket
alter table public.articles add column if not exists direct_url  text;         -- avisas egen adresse når feeden bare gir en Google Nyheter-lenke
alter table public.articles add column if not exists paywall     boolean;      -- true = pluss-sak, false = åpen, null = ukjent
alter table public.articles add column if not exists enriched_at timestamptz;  -- sist artikkelsiden ble slått opp (null = ikke ennå)

-- v1.4: hvilket område en lokalsak gjelder (id fra regions.json)
alter table public.articles add column if not exists area text;
create index if not exists articles_area_idx on public.articles (area);

-- v0.2: bilder og avisstil-titler (trygt å kjøre også på eksisterende tabell)
alter table public.articles add column if not exists kicker    text;
alter table public.articles add column if not exists image_url text;

-- v0.3: «Gledet meg»-knappen
alter table public.articles add column if not exists glad_count integer not null default 0;

-- v0.8: samme sak fra flere kilder + kildelogo
alter table public.articles add column if not exists story_id      bigint;  -- id til saken som «leder» historien (null = leder selv)
alter table public.articles add column if not exists source_domain text;    -- for logo (favicon)
create index if not exists articles_story_idx on public.articles (story_id);

create or replace function public.glad(article_id bigint)
returns integer language sql security definer set search_path = public as $$
  update articles set glad_count = glad_count + 1
  where id = article_id and score >= 6
  returning glad_count;
$$;
revoke all on function public.glad(bigint) from public;
grant execute on function public.glad(bigint) to anon;

create index if not exists articles_published_idx on public.articles (published_at desc);
create index if not exists articles_score_idx     on public.articles (score);

-- Sikkerhet: nettsiden (anon-nøkkel) kan BARE lese, og BARE gode saker.
-- Negative saker lagres for å kunne justere filteret, men forlater aldri databasen.
alter table public.articles enable row level security;

drop policy if exists "Offentlig lesing av gode nyheter" on public.articles;
create policy "Offentlig lesing av gode nyheter"
  on public.articles for select
  to anon
  using (score >= 6);

-- Skriving skjer kun fra GitHub Action med service_role-nøkkelen (omgår RLS).

-- v1.0: lokalt vær (og annen lokal info) for Lysglimt
create table if not exists public.local_info (
  key        text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.local_info enable row level security;
drop policy if exists "Offentlig lesing av lokal info" on public.local_info;
create policy "Offentlig lesing av lokal info" on public.local_info for select to anon using (true);

-- v1.2: Fellesturer («Bli med») per område – bare verifiserte turruter (ut.no), ingen klokkeslett
-- Turer: Claude søker på ut.no, jobben åpner hver side og godkjenner turen bare hvis den finnes og passer.
create table if not exists public.spots (
  id          bigint generated always as identity primary key,
  region      text not null,
  url         text not null,               -- turbeskrivelse på godkjent turside (ut.no/turforslag/…)
  name        text not null,               -- hentes fra tursiden
  difficulty  text,                        -- enkel | middels | krevende | ekspert (fra tursiden)
  activity    text,                        -- fottur | skitur | …
  distance_km numeric,
  duration_h  numeric,
  season_from smallint,                    -- måned 1–12 (fra «Sesong: Mai – okt»)
  season_to   smallint,
  approved    boolean not null default false,  -- settes av jobben etter verifisering
  verified_at timestamptz,
  source      text not null default 'manual',  -- manual | ai-søk
  note        text,                        -- resultat av siste sjekk
  created_at  timestamptz not null default now(),
  unique (region, url)
);
alter table public.spots enable row level security;   -- ingen offentlig tilgang; bare jobben leser

create table if not exists public.events (
  id          bigint generated always as identity primary key,
  region      text not null,
  date        date not null,
  slot        smallint not null default 0,   -- 0 = hovedtur, 1–2 = alternativer når den første har mange deltakere
  spot_name   text not null,
  url         text not null,
  pitch       text,
  kind        text,
  difficulty  text,
  distance_km numeric,
  duration_h  numeric,
  capacity    integer not null default 30,
  join_count  integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (region, date, slot)
);
create index if not exists events_region_date_idx on public.events (region, date);
alter table public.events enable row level security;
drop policy if exists "Offentlig lesing av kommende fellesturer" on public.events;
create policy "Offentlig lesing av kommende fellesturer" on public.events for select to anon using (date >= current_date);

create or replace function public.join_event(event_id bigint) returns integer
language sql security definer set search_path = public as $$
  update events set join_count = join_count + 1 where id = event_id and date >= current_date returning join_count;
$$;
create or replace function public.leave_event(event_id bigint) returns integer
language sql security definer set search_path = public as $$
  update events set join_count = greatest(join_count - 1, 0) where id = event_id and date >= current_date returning join_count;
$$;
revoke all on function public.join_event(bigint), public.leave_event(bigint) from public;
grant execute on function public.join_event(bigint), public.leave_event(bigint) to anon;

-- Startturer i Drammen (ut.no). De verifiseres automatisk ved første kjøring før de brukes.
insert into public.spots (region, url, name) values
  ('drammen', 'https://ut.no/turforslag/1112202525/fottur-til-prins-oscars-utsikt', 'Prins Oscars utsikt'),
  ('drammen', 'https://ut.no/turforslag/1112456/strms-torg-risdalstarnet', 'Risdalstårnet fra Strømsø torg'),
  ('drammen', 'https://ut.no/turforslag/118517/haukasutsikten', 'Haukåsutsikten'),
  ('drammen', 'https://ut.no/turforslag/117212', 'Bragernes–Kjøsterud over Landfallhytta'),
  ('drammen', 'https://www.ut.no/turforslag/1114463', 'Gatekunstvandring på Strømsø')
on conflict (region, url) do nothing;

-- v1.8: Databasen starter innsamlingsjobben hver halvtime.
-- GitHubs egen tidsplan viste seg upålitelig, så Supabase ber GitHub kjøre «Hent gode nyheter» via GitHubs API.
-- Krever en GitHub-nøkkel (fine-grained, bare dette repoet, Actions: Read and write) lagret i Vault
-- under navnet github_dispatch_token. Uten nøkkelen gjør jobben ingenting.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create schema if not exists private;   -- ikke tilgjengelig gjennom nettsidens API
revoke all on schema private from public, anon, authenticated;

create or replace function private.start_news_job()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  token text;
  request_id bigint;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name = 'github_dispatch_token';
  if token is null or length(trim(token)) = 0 then
    raise warning 'Gode nyheter: github_dispatch_token mangler i Vault – jobben ble ikke startet';
    return null;
  end if;
  select net.http_post(
    url := 'https://api.github.com/repos/richard-lund-bot/Gode-Nyheter/actions/workflows/fetch.yml/dispatches',
    body := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || trim(token),
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'Content-Type', 'application/json',
      'User-Agent', 'gode-nyheter-supabase-cron'),
    timeout_milliseconds := 10000
  ) into request_id;
  return request_id;
end
$$;
revoke all on function private.start_news_job() from public, anon, authenticated;

-- Kl. :22 og :52 hver time (UTC). GitHubs egen tidsplan (:07 og :37) står som reserve.
select cron.schedule('gode-nyheter-hent', '22,52 * * * *', $cron$select private.start_news_job()$cron$);
-- Rydd i loggen over cron-kjøringer én gang i døgnet
select cron.schedule('gode-nyheter-rydd-cronlogg', '15 3 * * *', $cron$delete from cron.job_run_details where end_time < now() - interval '7 days'$cron$);

-- v2.0: Åpen kasse – åpent regnskap, påmelding av lag og månedlig trekning
-- Regnskapet: én linje per inntekt, kostnad eller utbetaling. Alle kan lese, bare eieren og jobben kan skrive.
create table if not exists public.ledger (
  id          bigint generated always as identity primary key,
  booked_on   date not null default current_date,
  kind        text not null check (kind in ('inn', 'ut', 'utbetalt')),   -- inntekt, kostnad eller utbetalt til et lag
  title       text not null check (char_length(title) between 1 and 120),
  note        text check (note is null or char_length(note) <= 300),
  amount      numeric(12,2) not null check (amount >= 0),               -- kroner
  auto_key    text unique,            -- satt på linjer jobben fører selv, f.eks. 'ai-2026-11'
  auto_usd    numeric(14,6),          -- AI-linja: forbruk i dollar hittil i måneden
  auto_runs   integer,                -- AI-linja: antall kjøringer hittil i måneden
  auto_rate   numeric(10,4),          -- AI-linja: dollarkursen som ble brukt sist
  draw_id     bigint,                 -- utbetalinger: hvilken trekning linja gjelder
  created_at  timestamptz not null default now()
);
create index if not exists ledger_booked_on on public.ledger (booked_on desc);

-- Lag som er meldt på trekningen. Vises først når eieren har satt status til 'approved'.
create table if not exists public.clubs (
  id          bigint generated always as identity primary key,
  name        text not null check (char_length(name) between 2 and 80),
  area        text,                   -- id fra regions.json, eller null
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at  timestamptz not null default now()
);
create unique index if not exists clubs_name_area on public.clubs (lower(name), coalesce(area, ''));

-- Kontaktinformasjon ligger i en egen tabell uten offentlig tilgang.
create table if not exists public.club_contacts (
  club_id     bigint primary key references public.clubs(id) on delete cascade,
  email       text not null,
  org_number  text,
  created_at  timestamptz not null default now()
);

-- Trekninger: hvem som vant hvilken måneds pott, og hvilke lag som var med.
create table if not exists public.draws (
  id          bigint generated always as identity primary key,
  month       date not null unique,   -- første dag i måneden potten gjelder
  pot         numeric(12,2) not null check (pot > 0),
  club_id     bigint not null references public.clubs(id),
  entrants    jsonb not null,         -- navnene på alle lagene som var med i trekningen
  drawn_at    timestamptz not null default now(),
  paid_on     date,
  receipt_url text
);
create index if not exists draws_club on public.draws (club_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ledger_draw_fk') then
    alter table public.ledger add constraint ledger_draw_fk foreign key (draw_id) references public.draws(id);
  end if;
end $$;
create index if not exists ledger_draw on public.ledger (draw_id) where draw_id is not null;

alter table public.ledger enable row level security;
alter table public.clubs enable row level security;
alter table public.club_contacts enable row level security;   -- ingen offentlig tilgang
alter table public.draws enable row level security;
drop policy if exists "Offentlig lesing av regnskapet" on public.ledger;
create policy "Offentlig lesing av regnskapet" on public.ledger for select to anon using (true);
drop policy if exists "Offentlig lesing av godkjente lag" on public.clubs;
create policy "Offentlig lesing av godkjente lag" on public.clubs for select to anon using (status = 'approved');
drop policy if exists "Offentlig lesing av trekninger" on public.draws;
create policy "Offentlig lesing av trekninger" on public.draws for select to anon using (true);

-- Påmelding fra nettsiden. Laget blir stående som 'pending' til eieren har godkjent det.
create or replace function public.join_draw(p_name text, p_area text, p_email text, p_org text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_name  text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_org   text := nullif(regexp_replace(coalesce(p_org, ''), '\D', '', 'g'), '');
  v_area  text := nullif(btrim(coalesce(p_area, '')), '');
  v_id    bigint;
begin
  if char_length(v_name) < 2 or char_length(v_name) > 80 or v_name ~* '[<>]|https?:|www\.' then return 'invalid_name'; end if;
  if char_length(v_email) > 120 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' then return 'invalid_email'; end if;
  if v_org is not null and char_length(v_org) <> 9 then return 'invalid_org'; end if;
  if v_area is not null and v_area !~ '^[a-z0-9-]{1,40}$' then v_area := null; end if;
  -- enkel sperre mot masseinnsending
  if (select count(*) from public.clubs where created_at > now() - interval '1 hour') >= 20 then return 'busy'; end if;
  if exists (select 1 from public.clubs where lower(name) = lower(v_name) and coalesce(area, '') = coalesce(v_area, '')) then return 'exists'; end if;
  insert into public.clubs (name, area) values (v_name, v_area) returning id into v_id;
  insert into public.club_contacts (club_id, email, org_number) values (v_id, v_email, v_org);
  return 'ok';
end $$;
revoke all on function public.join_draw(text, text, text, text) from public, authenticated;
grant execute on function public.join_draw(text, text, text, text) to anon;

-- Innsamlingsjobben fører AI-kostnaden selv: én linje per måned som vokser for hver kjøring.
-- Uten kurs (Norges Bank svarer ikke) brukes kursen fra forrige føring.
create or replace function public.kasse_add_ai(p_usd numeric, p_rate numeric default null)
returns numeric language plpgsql security invoker set search_path = '' as $$
declare
  v_day  date := (now() at time zone 'Europe/Oslo')::date;
  v_key  text := 'ai-' || to_char(v_day, 'YYYY-MM');
  v_rate numeric := p_rate;
  v_sum  numeric;
begin
  if p_usd is null or p_usd < 0 then return null; end if;
  if v_rate is null or v_rate <= 0 then
    select auto_rate into v_rate from public.ledger where auto_rate is not null order by booked_on desc, id desc limit 1;
  end if;
  if v_rate is null then return null; end if;   -- ingen kurs å regne med ennå: ikke før noe
  insert into public.ledger (booked_on, kind, title, note, amount, auto_key, auto_usd, auto_runs, auto_rate)
  values (v_day, 'ut', 'Kunstig intelligens',
          'Claude leser, sorterer og skriver om nyhetene. Beregnet fra faktisk bruk og regnet om fra dollar med Norges Banks kurs.',
          round(p_usd * v_rate, 2), v_key, p_usd, 1, v_rate)
  on conflict (auto_key) do update
    set auto_usd  = public.ledger.auto_usd + excluded.auto_usd,
        auto_runs = public.ledger.auto_runs + 1,
        auto_rate = excluded.auto_rate,
        amount    = round((public.ledger.auto_usd + excluded.auto_usd) * excluded.auto_rate, 2),
        booked_on = excluded.booked_on
  returning amount into v_sum;
  return v_sum;
end $$;
revoke all on function public.kasse_add_ai(numeric, numeric) from public, anon, authenticated;
grant execute on function public.kasse_add_ai(numeric, numeric) to service_role;

-- Månedlig trekning. Går av seg selv den første i hver måned (se tidsplanen nederst).
-- Kan også kjøres for hånd:  select private.run_monthly_draw();
-- Potten er alt som er kommet inn minus alt som er gått ut til og med forrige måned.
-- Er den under minstegrensen, skjer ingenting, og potten går videre til neste måned.
create or replace function private.run_monthly_draw(p_min numeric default 500)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_this  date := date_trunc('month', now() at time zone 'Europe/Oslo')::date;
  v_month date := (v_this - interval '1 month')::date;
  v_pot   numeric;
  v_names jsonb;
  v_club  bigint;
  v_name  text;
  v_draw  bigint;
begin
  if exists (select 1 from public.draws where month = v_month) then return 'allerede trukket'; end if;
  select coalesce(sum(case kind when 'inn' then amount else -amount end), 0) into v_pot
    from public.ledger where booked_on < v_this;
  if v_pot < p_min then return 'potten er under minstegrensen'; end if;
  -- Med i trekningen: godkjente lag som ikke har vunnet de siste tolv månedene. Ett lodd per lag.
  create temp table _entrants on commit drop as
    select c.id, c.name from public.clubs c
     where c.status = 'approved'
       and not exists (select 1 from public.draws d where d.club_id = c.id and d.month > (v_month - interval '12 months'));
  select jsonb_agg(name order by name) into v_names from _entrants;
  if v_names is null then drop table _entrants; return 'ingen lag er med'; end if;
  select id, name into v_club, v_name from _entrants order by gen_random_uuid() limit 1;
  drop table _entrants;
  insert into public.draws (month, pot, club_id, entrants) values (v_month, v_pot, v_club, v_names) returning id into v_draw;
  insert into public.ledger (booked_on, kind, title, note, amount, draw_id)
  values (v_this, 'utbetalt', v_name, 'Trekning for ' || to_char(v_month, 'YYYY-MM'), v_pot, v_draw);
  return 'trukket: ' || v_name;
end $$;
revoke all on function private.run_monthly_draw(numeric) from public, anon, authenticated;

-- Trekningen den første i hver måned kl. 11:00 UTC (kl. 12 eller 13 norsk tid)
select cron.unschedule(jobid) from cron.job where jobname = 'gode-nyheter-trekning';
select cron.schedule('gode-nyheter-trekning', '0 11 1 * *', $$select private.run_monthly_draw();$$);
