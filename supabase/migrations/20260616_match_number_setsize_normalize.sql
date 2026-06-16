-- Fix: match_cards_number_setsize matchede number med EKSAKT streng (c.number = p_number).
-- Men kataloget har inkonsistent format: nogle kort "004/102", andre rå "4". OCR giver "4"
-- (ledende nuller strippet) → matchede kun "4"-format-kort, missede "004/102" (fx Charizard
-- 004/102 missede → fast-path valgte forkert kort numreret "4").
--
-- Fix: sammenlign den NUMERISKE del af number (før "/", uden ledende nuller) på begge sider.
--
-- KØR I SUPABASE STUDIO → SQL Editor.

CREATE OR REPLACE FUNCTION match_cards_number_setsize(
  p_game      text,
  p_number    text,
  p_set_total int
)
RETURNS TABLE (id text)
LANGUAGE sql STABLE
AS $$
  SELECT c.id
  FROM card_catalog c
  WHERE c.game = p_game
    AND regexp_replace(split_part(c.number, '/', 1), '^0+', '') = p_number
    AND (
      SELECT COUNT(*)::int
      FROM card_catalog c2
      WHERE c2.set_id = c.set_id
    ) BETWEEN (p_set_total - 5) AND (p_set_total + 60)
  LIMIT 10
$$;

-- Verificér: Charizard 004/102 (Base Set, 102 kort) skal nu matche number "4" + total 102.
SELECT c.name, c.number, c.set_name
FROM match_cards_number_setsize('pokemon', '4', 102) m
JOIN card_catalog c ON c.id = m.id;
