-- match_cards_number_setsize: finder kort baseret på kortnummer + set-størrelse
-- setTotal (fx 165 fra "025/165") identificerer sættet næsten entydigt.
-- Toleranceinterval: set har mindst p_set_total kort (base) og maks p_set_total+60 (secrets/promos).
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
    AND c.number = p_number
    AND (
      SELECT COUNT(*)::int
      FROM card_catalog c2
      WHERE c2.set_id = c.set_id
    ) BETWEEN (p_set_total - 5) AND (p_set_total + 60)
  LIMIT 10
$$;
