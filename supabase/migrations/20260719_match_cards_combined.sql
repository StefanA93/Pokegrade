-- match_cards_combined — kombineret hele-kort + kunst-region CLIP-score via HNSW.
-- YGO-kort er tekst-dominerede → hele-kort-embedding er svag; kunst-region (embedding_art) er stærkt
-- diskriminativ. Kombineret 0.5/0.5 tredobler kort-ID uden regression (valideret n=224, pulje 19k).
-- Lagret som embedding_combined = l2_normalize(embedding) || l2_normalize(embedding_art) (1024-dim, unit-halvdele),
-- så cosine på den = (cos_hele + cos_kunst)/2. HNSW-index (card_catalog_combined_hnsw) → ~1s (exact-scan var 60s).
-- Query-vektoren konkateneres på samme måde inde i funktionen; kun rækker MED embedding_combined (YGO m. kunst).
CREATE OR REPLACE FUNCTION match_cards_combined(
  query_embedding  vector(512),
  query_art        vector(512),
  game_filter      text,
  match_count      int DEFAULT 30
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
    c.id, c.name, c.number, c.set_name, c.phash, c.phash_art,
    (1 - (c.embedding_combined <=> (l2_normalize(query_embedding) || l2_normalize(query_art))))::float AS similarity
  FROM card_catalog c
  WHERE c.game = game_filter
    AND c.embedding_combined IS NOT NULL
  ORDER BY c.embedding_combined <=> (l2_normalize(query_embedding) || l2_normalize(query_art))
  LIMIT match_count;
$$;
