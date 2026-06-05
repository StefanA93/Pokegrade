-- ═══════════════════════════════════════════════════════════════════════════
-- GradeDex v4 — Database Completion Migration
-- Run in: https://supabase.com/dashboard/project/yezlcgooutpshqdhvufg/sql
-- Safe to run multiple times (all IF NOT EXISTS / OR REPLACE / DO NOTHING)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Tilføj Pokémon TCG Japan til games-registret ──────────────────────────
INSERT INTO games (id, label) VALUES
  ('pokemonjp', 'Pokémon TCG Japan')
ON CONFLICT (id) DO NOTHING;

-- ── 2. Konsolideret match_cards funktion ─────────────────────────────────────
-- Erstatter BEGGE tidligere versioner (docs/pgvector-migration.sql og
-- supabase-clip-migration.sql) med én komplet funktion.
-- Bruger HNSW-index (hurtigere end IVFFlat ved lave list-counts).
-- Returnerer alle felter brugt af api/match.js og api/scan-free.js.

DROP INDEX IF EXISTS card_catalog_embedding_idx;

CREATE INDEX IF NOT EXISTS card_catalog_embedding_hnsw_idx
  ON card_catalog USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE OR REPLACE FUNCTION match_cards(
  query_embedding vector(512),
  game_filter     text,
  match_count     int DEFAULT 20
)
RETURNS TABLE (
  id            text,
  name          text,
  number        text,
  set_id        text,
  set_name      text,
  rarity        text,
  finish_types  text[],
  image_url     text,
  game          text,
  phash         text,
  price_eur     numeric,
  cardmarket_url text,
  similarity    float
)
LANGUAGE sql STABLE AS $$
  SELECT
    c.id,
    c.name,
    c.number,
    c.set_id,
    c.set_name,
    c.rarity,
    c.finish_types,
    c.image_url,
    c.game,
    c.phash,
    COALESCE(p.price_sell, p.price_avg7, p.price_trend, c.price_eur) AS price_eur,
    COALESCE(p.cm_url, c.cardmarket_url)                             AS cardmarket_url,
    1 - (c.embedding <=> query_embedding)                            AS similarity
  FROM card_catalog c
  LEFT JOIN LATERAL (
    SELECT price_sell, price_avg7, price_trend, cm_url
    FROM   card_prices
    WHERE  catalog_id = c.id
    ORDER  BY fetched_at DESC
    LIMIT  1
  ) p ON true
  WHERE
    c.game      = game_filter
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── 3. Index på card_prices.fetched_at for LATERAL join ──────────────────────
CREATE INDEX IF NOT EXISTS card_prices_fetched_idx
  ON card_prices (catalog_id, fetched_at DESC);

-- ── 4. Sikr price_history RLS tillader service-role insert ───────────────────
-- Tjek at worker kan skrive prishistorik
DROP POLICY IF EXISTS "history_deny_insert" ON price_history;
CREATE POLICY "history_deny_insert"
  ON price_history FOR INSERT WITH CHECK (false);
-- Service role bypasser RLS — ingen ændring nødvendig her

-- ── Done ─────────────────────────────────────────────────────────────────────
-- Kør derefter (lokalt):
--   node scripts/import-game.js pokemonjp
--   node scripts/backfill-phash-only.js dragonball
--   node scripts/backfill-clip-embeddings.js dragonball
--   node scripts/backfill-phash-only.js lorcana
--   node scripts/backfill-clip-embeddings.js lorcana
