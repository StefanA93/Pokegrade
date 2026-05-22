-- ── card_catalog migration ────────────────────────────────────────────────────
-- Shared reference catalog populated by the import-cards Edge Function.
-- No user-specific data. Public read, service-role-only write.
-- Run in: https://supabase.com/dashboard/project/yezlcgooutpshqdhvufg/sql
--
-- Also adds card_number, set_name, catalog_id columns to the existing cards table.

-- ── Table ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS card_catalog (
  id                TEXT        PRIMARY KEY,                  -- e.g. "sv3-001", "mtg-<uuid>", "yugioh-12345"
  game              TEXT        NOT NULL,                     -- pokemon | mtg | yugioh
  name              TEXT        NOT NULL,
  number            TEXT,                                     -- "001", "45/165", set_code — null when unavailable
  set_id            TEXT,                                     -- API set identifier
  set_name          TEXT,
  rarity            TEXT,
  finish            TEXT,                                     -- foil variant label when applicable
  image_url         TEXT        NOT NULL,
  image_url_small   TEXT,
  cardmarket_url    TEXT,
  price_eur         NUMERIC(10, 2),                          -- market / average sell price
  price_eur_low     NUMERIC(10, 2),
  price_eur_trend   NUMERIC(10, 2),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Exact card lookup used by the scan flow (game + number + set)
CREATE INDEX IF NOT EXISTS card_catalog_game_number_set_idx
  ON card_catalog (game, number, set_id);

-- Name prefix/ilike search
CREATE INDEX IF NOT EXISTS card_catalog_name_idx
  ON card_catalog (name);

-- Full-text search across name + set_name
CREATE INDEX IF NOT EXISTS card_catalog_fts_idx
  ON card_catalog
  USING gin (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(set_name, '')));

-- Game filter (common WHERE clause in search)
CREATE INDEX IF NOT EXISTS card_catalog_game_idx
  ON card_catalog (game);

-- ── Row-Level Security ────────────────────────────────────────────────────────
ALTER TABLE card_catalog ENABLE ROW LEVEL SECURITY;

-- Anyone (anon + authenticated) can read the catalog
CREATE POLICY "catalog_public_select"
  ON card_catalog
  FOR SELECT
  USING (true);

-- No INSERT / UPDATE / DELETE policy for non-service roles.
-- The service role bypasses RLS entirely, which is the intended write path.
-- Explicit denial policies for clarity:

CREATE POLICY "catalog_deny_insert"
  ON card_catalog
  FOR INSERT
  WITH CHECK (false);

CREATE POLICY "catalog_deny_update"
  ON card_catalog
  FOR UPDATE
  USING (false);

CREATE POLICY "catalog_deny_delete"
  ON card_catalog
  FOR DELETE
  USING (false);

-- ── Extend existing cards table ───────────────────────────────────────────────
-- Links user cards to the shared catalog for exact identification + images.

ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS card_number TEXT,
  ADD COLUMN IF NOT EXISTS set_name    TEXT,
  ADD COLUMN IF NOT EXISTS catalog_id  TEXT REFERENCES card_catalog(id);

CREATE INDEX IF NOT EXISTS cards_catalog_id_idx ON cards (catalog_id);
