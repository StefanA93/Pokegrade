-- ============================================================
-- GradeDex pgvector migration
-- Run this in: https://supabase.com/dashboard/project/yezlcgooutpshqdhvufg/sql/new
-- ============================================================

-- Step 1: Enable pgvector extension
create extension if not exists vector;

-- Step 2: Add embedding column to card_catalog
alter table card_catalog
  add column if not exists embedding vector(512);

-- Step 3: HNSW index — fast cosine similarity search (<20ms on 500k vectors)
create index if not exists card_catalog_embedding_idx
  on card_catalog using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Step 4: RPC function used by api/match.js
-- Returns top-k most visually similar cards
create or replace function match_cards(
  query_embedding vector(512),
  game_filter text,
  match_count int default 20
)
returns table (
  id text,
  name text,
  rarity text,
  set_name text,
  set_id text,
  number text,
  image_url text,
  price_eur numeric,
  cardmarket_url text,
  similarity float
)
language sql stable
as $$
  select
    id,
    name,
    rarity,
    set_name,
    set_id,
    number,
    image_url,
    price_eur,
    cardmarket_url,
    1 - (embedding <=> query_embedding) as similarity
  from card_catalog
  where
    game = game_filter
    and embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
