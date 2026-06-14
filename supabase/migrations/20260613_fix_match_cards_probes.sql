-- Fix match_cards: IVFFlat probes=1 (default) giver 0 resultater for kamera-embeddings.
-- Ændrer til plpgsql med SET LOCAL ivfflat.probes = 30 → søger 30% af alle clusters.
-- Dette giver ~95%+ recall og løser "no card found" problemet.
--
-- KØR DETTE I SUPABASE STUDIO → SQL Editor:
-- https://supabase.com/dashboard/project/yezlcgooutpshqdhvufg/sql

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
LANGUAGE plpgsql
AS $$
BEGIN
  -- Søg 30 af 100 IVFFlat clusters i stedet for kun 1 (default)
  -- probes=30 giver ~95%+ recall med god hastighed på 31K vektorer
  SET LOCAL ivfflat.probes = 30;
  RETURN QUERY
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
END;
$$;

-- Bekræft at funktionen er opdateret
SELECT routine_name, routine_language
FROM information_schema.routines
WHERE routine_name = 'match_cards' AND routine_schema = 'public';
