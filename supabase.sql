-- Stämpla – databasen i Supabase.
--
-- Kör hela filen en gång i Supabase: SQL Editor → New query → klistra in → Run.
-- Filen går att köra igen om du uppdaterar den. Tabellerna och datan finns kvar,
-- bara funktionerna byts ut.
--
-- Allt som webbsidan gör går via funktionerna nedan. Tabellerna går inte att läsa
-- eller ändra direkt från webben, så en elev kan inte se andras data eller fuska
-- genom att skriva i databasen. Stämplingen räknas ut här i databasen, inte i mobilen.

set client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- Inställningar
-- ---------------------------------------------------------------------------

-- En GPS-position med sämre noggrannhet än så här (meter) får inte stämpla.
create or replace function stampla_max_noggrannhet_stampling() returns int language sql immutable as 'select 30';
-- Positioner sämre än så här sparas inte i elevens rutt.
create or replace function stampla_max_noggrannhet_rutt() returns int language sql immutable as 'select 50';
-- Spara högst en ruttpunkt per så här många millisekunder.
create or replace function stampla_rutt_intervall_ms() returns int language sql immutable as 'select 2000';

-- ---------------------------------------------------------------------------
-- Tabeller
-- ---------------------------------------------------------------------------

create table if not exists banor (
  id text primary key,
  agare uuid not null references auth.users (id) on delete cascade,
  namn text not null,
  karttyp text not null default 'gata',
  radie int not null default 10,
  start jsonb not null,
  kontroller jsonb not null,
  mal jsonb not null,
  skapad timestamptz not null default now(),
  andrad timestamptz not null default now()
);
create index if not exists banor_agare on banor (agare);

create table if not exists omgangar (
  id text primary key,
  agare uuid not null references auth.users (id) on delete cascade,
  pin text not null,
  namn text not null,
  bana_id text,                -- banan kan tas bort, omgången finns kvar
  bana jsonb not null,         -- kopia: ändringar i banan påverkar inte en pågående omgång
  testlage boolean not null default false,
  status text not null default 'aktiv',
  startad timestamptz not null default now(),
  avslutad timestamptz
);
create index if not exists omgangar_agare on omgangar (agare);
create unique index if not exists omgangar_aktiv_pin on omgangar (pin) where status = 'aktiv';

create table if not exists deltagare (
  id text primary key,
  omgang_id text not null references omgangar (id) on delete cascade,
  token text not null,
  namn text not null,
  status text not null default 'vantar',     -- vantar -> springer -> klar / avbrot
  simulerad boolean not null default false,
  start_tid bigint,                          -- elevens klocka (ms) när hen tryckte Starta
  start_mottagen bigint,                     -- serverns klocka när starten kom fram
  mal_tid bigint,
  nasta_index int not null default 0,        -- lika med antalet kontroller betyder mål
  stamplingar jsonb not null default '[]',
  overhoppade jsonb not null default '[]',
  position jsonb,
  senaste_fix_tid bigint not null default 0,
  spar jsonb not null default '[]',
  senast_sedd bigint not null,
  lamnat_appen int not null default 0
);
create index if not exists deltagare_omgang on deltagare (omgang_id);

-- Ingen direkt åtkomst från webben. Allt går via funktionerna.
alter table banor enable row level security;
alter table omgangar enable row level security;
alter table deltagare enable row level security;
revoke all on banor, omgangar, deltagare from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Hjälpfunktioner
-- ---------------------------------------------------------------------------

create or replace function stampla_nu_ms() returns bigint language sql volatile
as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint $$;

create or replace function stampla_nytt_id(prefix text) returns text language sql volatile
as $$ select prefix || left(replace(gen_random_uuid()::text, '-', ''), 12) $$;

-- Hemlig nyckel som bara elevens mobil känner till.
create or replace function stampla_ny_token() returns text language sql volatile
as $$ select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') $$;

-- Kastar ett fel som webbsidan visar för användaren. Status blir HTTP-statuskoden.
create or replace function stampla_fel(status int, meddelande text) returns void language plpgsql
as $$ begin raise exception using errcode = 'PT' || status, message = meddelande; end $$;

-- Avstånd i meter mellan två punkter (haversine), samma som js/geo.js.
create or replace function stampla_avstand(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable
as $$
  select 2 * 6371008.8 * asin(least(1, sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2 +
    cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lng2 - lng1) / 2) ^ 2
  )))
$$;

create or replace function stampla_inloggad() returns uuid language plpgsql stable
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then perform stampla_fel(401, 'Du är inte inloggad.'); end if;
  return uid;
end $$;

create or replace function stampla_text(varde jsonb, max_langd int, falt text) returns text language plpgsql immutable
as $$
declare s text;
begin
  s := case when varde is null or jsonb_typeof(varde) = 'null' then ''
            when jsonb_typeof(varde) = 'string' then varde #>> '{}'
            else varde::text end;
  s := btrim(regexp_replace(s, '\s+', ' ', 'g'));
  if s = '' then perform stampla_fel(400, falt || ' saknas.'); end if;
  return left(s, max_langd);
end $$;

create or replace function stampla_punkt(p jsonb, falt text) returns jsonb language plpgsql immutable
as $$
declare lat float8; lng float8;
begin
  begin
    lat := (p ->> 'lat')::float8;
    lng := (p ->> 'lng')::float8;
  exception when others then
    lat := null;
  end;
  if lat is null or lng is null or lat = 'NaN' or lng = 'NaN' or abs(lat) > 90 or abs(lng) > 180 then
    perform stampla_fel(400, falt || ' har ogiltiga koordinater.');
  end if;
  return jsonb_build_object('lat', round(lat::numeric, 7), 'lng', round(lng::numeric, 7));
end $$;

create or replace function stampla_bana_json(b banor) returns jsonb language sql stable
as $$
  select jsonb_build_object('id', b.id, 'namn', b.namn, 'karttyp', b.karttyp, 'radie', b.radie,
    'start', b.start, 'kontroller', b.kontroller, 'mal', b.mal, 'skapad', b.skapad, 'andrad', b.andrad)
$$;

create or replace function stampla_omgang_sammanfattning(o omgangar) returns jsonb language sql stable
as $$
  select jsonb_build_object(
    'id', o.id, 'pin', o.pin, 'namn', o.namn, 'banaId', o.bana_id,
    'banaNamn', o.bana ->> 'namn', 'antalKontroller', jsonb_array_length(o.bana -> 'kontroller'),
    'testlage', o.testlage, 'status', o.status, 'startad', o.startad, 'avslutad', o.avslutad,
    'antalDeltagare', (select count(*) from deltagare d where d.omgang_id = o.id),
    'antalIMal', (select count(*) from deltagare d where d.omgang_id = o.id and d.status = 'klar'))
$$;

-- Det eleven får veta om omgången. Lärarens uppgifter och andras data skickas inte.
create or replace function stampla_elev_omgang(o omgangar) returns jsonb language sql stable
as $$
  select jsonb_build_object('id', o.id, 'namn', o.namn, 'status', o.status, 'testlage', o.testlage,
    'bana', jsonb_build_object('namn', o.bana -> 'namn', 'karttyp', o.bana -> 'karttyp', 'radie', o.bana -> 'radie',
      'start', o.bana -> 'start', 'kontroller', o.bana -> 'kontroller', 'mal', o.bana -> 'mal'))
$$;

create or replace function stampla_elev_lage(o omgangar, d deltagare) returns jsonb language sql stable
as $$
  select jsonb_build_object(
    'status', d.status, 'omgangStatus', o.status, 'nastaIndex', d.nasta_index,
    'stamplingar', coalesce((select jsonb_agg(jsonb_build_object('index', s -> 'index', 'tid', s -> 'tid'))
                             from jsonb_array_elements(d.stamplingar) s), '[]'),
    'overhoppade', d.overhoppade, 'startTid', d.start_tid, 'malTid', d.mal_tid, 'simulerad', d.simulerad)
$$;

-- Det läraren ser om en deltagare. Token och hela rutten skickas inte här.
create or replace function stampla_larar_deltagare(d deltagare) returns jsonb language sql stable
as $$
  select jsonb_build_object(
    'id', d.id, 'namn', d.namn, 'status', d.status, 'simulerad', d.simulerad,
    'startTid', d.start_tid, 'startMottagen', d.start_mottagen, 'malTid', d.mal_tid,
    'nastaIndex', d.nasta_index, 'stamplingar', d.stamplingar, 'overhoppade', d.overhoppade,
    'position', d.position, 'senasteFixTid', d.senaste_fix_tid, 'senastSedd', d.senast_sedd,
    'lamnatAppen', d.lamnat_appen, 'antalRuttpunkter', jsonb_array_length(d.spar))
$$;

create or replace function stampla_min_bana(p_id text) returns banor language plpgsql stable
as $$
declare b banor;
begin
  select * into b from banor where id = p_id and agare = stampla_inloggad();
  if not found then perform stampla_fel(404, 'Banan finns inte.'); end if;
  return b;
end $$;

create or replace function stampla_min_omgang(p_id text) returns omgangar language plpgsql stable
as $$
declare o omgangar;
begin
  select * into o from omgangar where id = p_id and agare = stampla_inloggad();
  if not found then perform stampla_fel(404, 'Omgången finns inte.'); end if;
  return o;
end $$;

-- ---------------------------------------------------------------------------
-- Lärarens funktioner (kräver inloggning, och man ser bara sina egna banor)
-- ---------------------------------------------------------------------------

create or replace function larare_banor() returns jsonb
language sql security definer set search_path = public, extensions
as $$
  select jsonb_build_object('banor', coalesce(jsonb_agg(stampla_bana_json(b) order by b.andrad desc), '[]'))
  from banor b where b.agare = stampla_inloggad()
$$;

create or replace function larare_bana(p_id text) returns jsonb
language sql security definer set search_path = public, extensions
as $$ select jsonb_build_object('bana', stampla_bana_json(stampla_min_bana(p_id))) $$;

create or replace function larare_spara_bana(p_id text, p_bana jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  uid uuid := stampla_inloggad();
  k jsonb := p_bana -> 'kontroller';
  v_kontroller jsonb := '[]';
  v_radie int;
  b banor;
  i int;
begin
  if p_bana -> 'start' is null or jsonb_typeof(p_bana -> 'start') = 'null' then perform stampla_fel(400, 'Banan behöver en start.'); end if;
  if k is null or jsonb_typeof(k) <> 'array' or jsonb_array_length(k) = 0 then perform stampla_fel(400, 'Banan behöver minst en kontroll.'); end if;
  if jsonb_array_length(k) > 60 then perform stampla_fel(400, 'En bana kan ha högst 60 kontroller.'); end if;
  if p_bana -> 'mal' is null or jsonb_typeof(p_bana -> 'mal') = 'null' then perform stampla_fel(400, 'Banan behöver ett mål.'); end if;
  for i in 0 .. jsonb_array_length(k) - 1 loop
    v_kontroller := v_kontroller || jsonb_build_array(stampla_punkt(k -> i, 'Kontroll ' || (i + 1)));
  end loop;
  begin
    v_radie := round((p_bana ->> 'radie')::numeric);
  exception when others then v_radie := 10;
  end;
  v_radie := least(50, greatest(5, coalesce(v_radie, 10)));

  if p_id is null then
    insert into banor (id, agare, namn, karttyp, radie, start, kontroller, mal)
    values (stampla_nytt_id('b'), uid, stampla_text(p_bana -> 'namn', 60, 'Banans namn'),
            case when p_bana ->> 'karttyp' = 'terrang' then 'terrang' else 'gata' end, v_radie,
            stampla_punkt(p_bana -> 'start', 'Starten'), v_kontroller, stampla_punkt(p_bana -> 'mal', 'Målet'))
    returning * into b;
  else
    perform stampla_min_bana(p_id);
    update banor set
      namn = stampla_text(p_bana -> 'namn', 60, 'Banans namn'),
      karttyp = case when p_bana ->> 'karttyp' = 'terrang' then 'terrang' else 'gata' end,
      radie = v_radie,
      start = stampla_punkt(p_bana -> 'start', 'Starten'),
      kontroller = v_kontroller,
      mal = stampla_punkt(p_bana -> 'mal', 'Målet'),
      andrad = now()
    where id = p_id returning * into b;
  end if;
  return jsonb_build_object('bana', stampla_bana_json(b));
end $$;

create or replace function larare_ta_bort_bana(p_id text) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
begin
  perform stampla_min_bana(p_id);
  delete from banor where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function larare_omgangar() returns jsonb
language sql security definer set search_path = public, extensions
as $$
  select jsonb_build_object('omgangar', coalesce(jsonb_agg(stampla_omgang_sammanfattning(o) order by o.startad desc), '[]'))
  from omgangar o where o.agare = stampla_inloggad()
$$;

create or replace function larare_starta_omgang(p_bana_id text, p_namn text, p_testlage boolean) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  b banor := stampla_min_bana(p_bana_id);
  o omgangar;
  v_pin text;
begin
  loop
    v_pin := lpad((100000 + floor(random() * 900000))::int::text, 6, '0');
    exit when not exists (select 1 from omgangar where pin = v_pin and status = 'aktiv');
  end loop;
  insert into omgangar (id, agare, pin, namn, bana_id, bana, testlage)
  values (stampla_nytt_id('o'), b.agare, v_pin,
          stampla_text(to_jsonb(coalesce(nullif(btrim(p_namn), ''), b.namn)), 40, 'Omgångens namn'),
          b.id, stampla_bana_json(b), coalesce(p_testlage, false))
  returning * into o;
  return jsonb_build_object('omgang', stampla_omgang_sammanfattning(o));
end $$;

create or replace function larare_omgang(p_id text) returns jsonb
language sql security definer set search_path = public, extensions
as $$
  with o as (select * from stampla_min_omgang(p_id))
  select jsonb_build_object('nu', stampla_nu_ms(), 'omgang',
    stampla_omgang_sammanfattning(o.*) || jsonb_build_object(
      'bana', o.bana,
      'deltagare', coalesce((select jsonb_agg(stampla_larar_deltagare(d.*)) from deltagare d where d.omgang_id = o.id), '[]')))
  from o
$$;

create or replace function larare_rutt(p_id text, p_did text) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare d deltagare;
begin
  perform stampla_min_omgang(p_id);
  select * into d from deltagare where id = p_did and omgang_id = p_id;
  if not found then perform stampla_fel(404, 'Eleven finns inte i omgången.'); end if;
  return jsonb_build_object('rutt', d.spar);
end $$;

create or replace function larare_avsluta_omgang(p_id text) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare o omgangar := stampla_min_omgang(p_id);
begin
  if o.status = 'aktiv' then
    update omgangar set status = 'avslutad', avslutad = now() where id = p_id returning * into o;
  end if;
  return jsonb_build_object('omgang', stampla_omgang_sammanfattning(o));
end $$;

create or replace function larare_ta_bort_omgang(p_id text) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
begin
  perform stampla_min_omgang(p_id);
  delete from omgangar where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Elevens funktioner (ingen inloggning, eleven känns igen på sin hemliga token)
-- ---------------------------------------------------------------------------

create or replace function stampla_hamta_deltagare(p_omgang_id text, p_did text, p_token text, out o omgangar, out d deltagare)
language plpgsql
as $$
begin
  select * into o from omgangar where id = p_omgang_id;
  if not found then perform stampla_fel(404, 'Omgången finns inte.'); end if;
  select * into d from deltagare where id = p_did and omgang_id = p_omgang_id for update;
  if not found or p_token is null or d.token <> p_token then perform stampla_fel(403, 'Okänd deltagare.'); end if;
end $$;

create or replace function elev_pin(p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare o omgangar;
begin
  select * into o from omgangar where pin = p_pin and status = 'aktiv';
  if not found then
    perform stampla_fel(404, 'Det finns ingen pågående omgång med den PIN-koden. Kolla siffrorna med din lärare.');
  end if;
  return jsonb_build_object('omgang', stampla_elev_omgang(o));
end $$;

create or replace function elev_ga_med(p_omgang_id text, p_namn text) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare o omgangar; d deltagare;
begin
  select * into o from omgangar where id = p_omgang_id;
  if not found then perform stampla_fel(404, 'Omgången finns inte.'); end if;
  if o.status <> 'aktiv' then perform stampla_fel(409, 'Omgången är avslutad.'); end if;
  if (select count(*) from deltagare where omgang_id = o.id) >= 500 then perform stampla_fel(429, 'Omgången är full.'); end if;
  insert into deltagare (id, omgang_id, token, namn, senast_sedd)
  values (stampla_nytt_id('d'), o.id, stampla_ny_token(),
          stampla_text(to_jsonb(p_namn), 40, 'Namn'), stampla_nu_ms())
  returning * into d;
  return jsonb_build_object('deltagareId', d.id, 'token', d.token,
    'omgang', stampla_elev_omgang(o), 'lage', stampla_elev_lage(o, d));
end $$;

create or replace function elev_lage(p_omgang_id text, p_did text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare r record;
begin
  r := stampla_hamta_deltagare(p_omgang_id, p_did, p_token);
  update deltagare set senast_sedd = stampla_nu_ms() where id = p_did;
  return jsonb_build_object('omgang', stampla_elev_omgang(r.o), 'lage', stampla_elev_lage(r.o, r.d));
end $$;

create or replace function elev_starta(p_omgang_id text, p_did text, p_token text, p_tid bigint) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare r record; o omgangar; d deltagare;
begin
  r := stampla_hamta_deltagare(p_omgang_id, p_did, p_token);
  o := r.o; d := r.d;
  if o.status <> 'aktiv' then perform stampla_fel(409, 'Omgången är avslutad.'); end if;
  if d.status = 'vantar' then
    update deltagare set status = 'springer', start_tid = coalesce(p_tid, stampla_nu_ms()),
      start_mottagen = stampla_nu_ms(), senast_sedd = stampla_nu_ms()
    where id = d.id returning * into d;
  end if;
  return jsonb_build_object('lage', stampla_elev_lage(o, d));
end $$;

-- Tar emot mobilens GPS-positioner och stämplar när eleven är framme vid nästa kontroll.
create or replace function elev_positioner(p_omgang_id text, p_did text, p_token text, p_fixar jsonb, p_lamnat_appen int)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  r record; o omgangar; d deltagare;
  fix jsonb; lat float8; lng float8; acc float8; t bigint; sim boolean;
  sista jsonb; antal_k int; mal jsonb; avst float8; nu bigint := stampla_nu_ms();
begin
  r := stampla_hamta_deltagare(p_omgang_id, p_did, p_token);
  o := r.o; d := r.d;
  d.senast_sedd := nu;
  if p_lamnat_appen is not null then d.lamnat_appen := greatest(0, least(9999, p_lamnat_appen)); end if;
  antal_k := jsonb_array_length(o.bana -> 'kontroller');

  if o.status = 'aktiv' and d.status = 'springer' and jsonb_typeof(p_fixar) = 'array' then
    for fix in select f from jsonb_array_elements(p_fixar) with ordinality as x(f, n) where n <= 500 order by n loop
      begin
        lat := (fix ->> 'lat')::float8;
        lng := (fix ->> 'lng')::float8;
        acc := (fix ->> 'acc')::float8;
        t := round((fix ->> 't')::numeric)::bigint;
      exception when others then
        continue;
      end;
      continue when lat is null or lng is null or acc is null or t is null;
      continue when abs(lat) > 90 or abs(lng) > 180 or acc < 0 or acc = 'NaN' or lat = 'NaN' or lng = 'NaN';
      continue when t <= d.senaste_fix_tid or t < d.start_tid;   -- dubblett eller före start

      sim := coalesce(fix -> 'sim' = 'true'::jsonb, false);
      continue when sim and not o.testlage;                      -- simulerad GPS bara i testomgångar
      if sim then d.simulerad := true; end if;

      d.senaste_fix_tid := t;
      d.position := jsonb_build_object('lat', lat, 'lng', lng, 'acc', round(acc), 't', t, 'mottagen', nu);

      sista := d.spar -> -1;
      if acc <= stampla_max_noggrannhet_rutt() and (sista is null or t - (sista ->> 2)::bigint >= stampla_rutt_intervall_ms()) then
        d.spar := d.spar || jsonb_build_array(jsonb_build_array(round(lat::numeric, 6), round(lng::numeric, 6), t));
      end if;

      continue when d.status <> 'springer' or acc > stampla_max_noggrannhet_stampling();

      mal := case when d.nasta_index < antal_k then o.bana -> 'kontroller' -> d.nasta_index else o.bana -> 'mal' end;
      avst := stampla_avstand(lat, lng, (mal ->> 'lat')::float8, (mal ->> 'lng')::float8);
      continue when avst > (o.bana ->> 'radie')::float8;

      d.stamplingar := d.stamplingar || jsonb_build_array(jsonb_build_object(
        'index', d.nasta_index, 'tid', t, 'avstand', round(avst), 'noggrannhet', round(acc)));
      if d.nasta_index >= antal_k then
        d.status := 'klar';
        d.mal_tid := t;
      else
        d.nasta_index := d.nasta_index + 1;
      end if;
    end loop;
  end if;

  update deltagare set senast_sedd = d.senast_sedd, lamnat_appen = d.lamnat_appen, simulerad = d.simulerad,
    senaste_fix_tid = d.senaste_fix_tid, position = d.position, spar = d.spar, stamplingar = d.stamplingar,
    status = d.status, mal_tid = d.mal_tid, nasta_index = d.nasta_index
  where id = d.id;
  return jsonb_build_object('lage', stampla_elev_lage(o, d));
end $$;

create or replace function elev_hoppa_over(p_omgang_id text, p_did text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare r record; o omgangar; d deltagare;
begin
  r := stampla_hamta_deltagare(p_omgang_id, p_did, p_token);
  o := r.o; d := r.d;
  if o.status = 'aktiv' and d.status = 'springer' and d.nasta_index < jsonb_array_length(o.bana -> 'kontroller') then
    update deltagare set overhoppade = overhoppade || to_jsonb(nasta_index), nasta_index = nasta_index + 1
    where id = d.id returning * into d;
  end if;
  return jsonb_build_object('lage', stampla_elev_lage(o, d));
end $$;

create or replace function elev_avbryt(p_omgang_id text, p_did text, p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare r record; o omgangar; d deltagare;
begin
  r := stampla_hamta_deltagare(p_omgang_id, p_did, p_token);
  o := r.o; d := r.d;
  if d.status in ('springer', 'vantar') then
    update deltagare set status = 'avbrot' where id = d.id returning * into d;
  end if;
  return jsonb_build_object('lage', stampla_elev_lage(o, d));
end $$;

-- ---------------------------------------------------------------------------
-- Behörigheter: webben får bara anropa lärar- och elevfunktionerna
-- ---------------------------------------------------------------------------

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'stampla\_%' or p.proname like 'larare\_%' or p.proname like 'elev\_%')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname like 'larare\_%' then
      execute format('grant execute on function %s to authenticated', f.sig);
    elsif f.proname like 'elev\_%' then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    end if;
  end loop;
end $$;

-- Be API:t läsa in de nya funktionerna direkt.
notify pgrst, 'reload schema';
