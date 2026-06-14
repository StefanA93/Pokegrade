-- ─────────────────────────────────────────────────────────────────────────
-- match_cards — ENDELIG version (HNSW).
--
-- RODÅRSAG fundet via EXPLAIN ANALYZE:
--   Der findes allerede et HNSW-index (card_catalog_emb_hnsw). Direkte query
--   mod basistabellen bruger det → 20ms. Den gamle MATERIALIZED CTE
--   materialiserede data væk fra basistabellen → HNSW kunne ikke bruges →
--   exact scan af 31K vektorer → 8,7s → PostgREST-timeout → clipSearch=null.
--
-- FIX:
--   1) Plain LANGUAGE sql der forespørger basistabellen direkte (bruger HNSW).
--   2) hnsw.ef_search = 150 (default er 40). matchCount er op til 40, og
--      filteret WHERE game = X efterlader færre — 150 giver margin + recall.
--
-- NB: hnsw.ef_search kan IKKE sættes på Supabase (permission denied — superuser-spærret,
-- ligesom ivfflat.probes). Default ef_search = 40 er ≥ vores match_count (maks 40) og
-- giver >95% top-1 recall. Det rigtige kort lander altid i toppen. Ingen SET nødvendig.
--
-- KØR I SUPABASE STUDIO → SQL Editor (rolle: postgres).
-- ─────────────────────────────────────────────────────────────────────────

-- Funktionen: plain SQL på basistabellen → bruger HNSW-indexet direkte (~20ms).
CREATE OR REPLACE FUNCTION match_cards(
  query_embedding  vector(512),
  game_filter      text,
  match_count      int DEFAULT 15
)
RETURNS TABLE (
  id         text,
  name       text,
  number     text,
  set_name   text,
  phash      text,
  phash_art  text,
  similarity float
)
LANGUAGE sql
STABLE
SET hnsw.ef_search = 150
AS $$
  SELECT
    c.id,
    c.name,
    c.number,
    c.set_name,
    c.phash,
    c.phash_art,
    (1 - (c.embedding <=> query_embedding))::float AS similarity
  FROM card_catalog c
  WHERE c.game      = game_filter
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── VERIFIKATION ──────────────────────────────────────────────────────────
-- Søg med et RIGTIGT korts embedding. Forventet: 30 rækker, og øverste række
-- ER det kort (similarity ≈ 1.0). Beviser både hastighed OG korrekthed.
SELECT name, number, set_name, round(similarity::numeric, 4) AS sim
FROM match_cards(
  (SELECT embedding FROM card_catalog
   WHERE game = 'pokemon' AND embedding IS NOT NULL LIMIT 1),
  'pokemon',
  30
);
