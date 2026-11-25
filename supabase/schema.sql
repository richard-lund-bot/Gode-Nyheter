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
