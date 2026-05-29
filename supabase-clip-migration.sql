-- Kør dette i Supabase SQL Editor
-- Tilføjer CLIP embedding-kolonne og vector-søgefunktion til card_catalog

-- 1. Aktiver pgvector extension
create extension if not exists vector;

-- 2. Tilføj embedding kolonne (512-dim CLIP)
alter table card_catalog
  add column if not exists embedding vector(512);

-- 3. IVFFlat index til hurtig approximate nearest neighbor søgning
--    lists = 100 passer til ~40K kort (sqrt(N) er tommelfingerregel)
--    Byg EFTER backfill er færdig for optimal ydelse.
create index if not exists card_catalog_embedding_idx
  on card_catalog using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- 4. match_cards funktion — bruges af api/scan-free.js og api/match.js
create or replace function match_cards(
  query_embedding vector(512),
  game_filter     text,
  match_count     int default 20
)
returns table (
  id           text,
  name         text,
  number       text,
  set_id       text,
  set_name     text,
  rarity       text,
  finish_types text[],
  image_url    text,
  game         text,
  phash        text,
  similarity   float
)
language sql stable as $$
  select
    id,
    name,
    number,
    set_id,
    set_name,
    rarity,
    finish_types,
    image_url,
    game,
    phash,
    1 - (embedding <=> query_embedding) as similarity
  from card_catalog
  where
    game      = game_filter
    and embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- 5. Verificér at det virker (kør efter migration)
-- select count(*) from card_catalog where embedding is not null;
