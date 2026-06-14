-- ============================================================
-- Migration: pgvector + match_cards + phash_art
-- embedding kolonne er allerede vector(512) — ingen dublering nødvendig
-- Kør i Supabase Studio → SQL Editor (brug BEGIN READ WRITE; ... COMMIT;)
-- ============================================================

-- 1. Aktivér pgvector-extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Tilføj phash_art til card_catalog (artwork-zone perceptual hash)
ALTER TABLE card_catalog
  ADD COLUMN IF NOT EXISTS phash_art text;

-- 3. Ryd op hvis embedding_vec blev oprettet ved fejl (frigør diskplads)
ALTER TABLE card_catalog
  DROP COLUMN IF EXISTS embedding_vec;

-- 4. IVFFlat index direkte på embedding kolonnen (sparer ~62MB vs. dublering)
--    lists = 100 er passende for ~31K vektorer
CREATE INDEX IF NOT EXISTS card_catalog_embedding_idx
  ON card_catalog
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 5. match_cards funktion — returnerer de N mest visuelt lignende kort
-- VIGTIGT: parameter hedder game_filter (matcher REST API kald fra scan-free.js + match.js)
CREATE OR REPLACE FUNCTION match_cards(
  query_embedding  vector(512),
  game_filter      text,
  match_count      int   DEFAULT 15
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
LANGUAGE sql STABLE
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
  WHERE c.game = game_filter
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- 6. Bekræft opsætning
SELECT
  COUNT(*) FILTER (WHERE embedding IS NOT NULL)  AS with_embedding,
  COUNT(*) FILTER (WHERE phash_art IS NOT NULL)  AS with_phash_art,
  COUNT(*)                                        AS total
FROM card_catalog
WHERE game = 'pokemon';
