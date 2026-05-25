-- ═══════════════════════════════════════════════════════════════════════════
-- GradeDex v3 — Platform Migration
-- Run in: https://supabase.com/dashboard/project/yezlcgooutpshqdhvufg/sql
-- Safe to run multiple times (all IF NOT EXISTS / DO NOTHING)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Games registry ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  active      BOOLEAN DEFAULT true,
  sync_config JSONB DEFAULT '{}'
);

INSERT INTO games (id, label) VALUES
  ('pokemon',    'Pokémon TCG'),
  ('mtg',        'Magic: The Gathering'),
  ('yugioh',     'Yu-Gi-Oh!'),
  ('onepiece',   'One Piece TCG'),
  ('lorcana',    'Disney Lorcana'),
  ('dragonball', 'Dragon Ball Super Card Game')
ON CONFLICT (id) DO NOTHING;

-- ── 2. Sets (unified across all games) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS sets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       TEXT NOT NULL REFERENCES games(id),
  name          TEXT NOT NULL,
  code          TEXT,
  release_date  DATE,
  card_count    INT,
  image_url     TEXT,
  provider_ids  JSONB DEFAULT '{}',
  synced_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(game_id, code)
);

ALTER TABLE sets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sets_public_select" ON sets FOR SELECT USING (true);
CREATE POLICY "sets_deny_insert"   ON sets FOR INSERT WITH CHECK (false);
CREATE POLICY "sets_deny_update"   ON sets FOR UPDATE USING (false);
CREATE POLICY "sets_deny_delete"   ON sets FOR DELETE USING (false);

CREATE INDEX IF NOT EXISTS sets_game_idx ON sets(game_id);
CREATE INDEX IF NOT EXISTS sets_code_idx ON sets(game_id, code);

-- ── 3. Enhance card_catalog ───────────────────────────────────────────────────
-- Add columns for v3 features. card_catalog already exists.

ALTER TABLE card_catalog
  ADD COLUMN IF NOT EXISTS set_db_id     UUID REFERENCES sets(id),
  ADD COLUMN IF NOT EXISTS phash         TEXT,
  ADD COLUMN IF NOT EXISTS image_key     TEXT,
  ADD COLUMN IF NOT EXISTS thumb_key     TEXT,
  ADD COLUMN IF NOT EXISTS finish_types  TEXT[] DEFAULT ARRAY['Normal'],
  ADD COLUMN IF NOT EXISTS price_avg7    NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS price_avg30   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS price_fetched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS card_catalog_phash_idx
  ON card_catalog(phash) WHERE phash IS NOT NULL;

CREATE INDEX IF NOT EXISTS card_catalog_set_db_idx
  ON card_catalog(set_db_id) WHERE set_db_id IS NOT NULL;

-- ── 4. Provider ID mappings ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS card_provider_ids (
  catalog_id   TEXT NOT NULL REFERENCES card_catalog(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  external_url TEXT,
  PRIMARY KEY (catalog_id, provider)
);

ALTER TABLE card_provider_ids ENABLE ROW LEVEL SECURITY;
CREATE POLICY "provider_ids_public_select" ON card_provider_ids FOR SELECT USING (true);
CREATE POLICY "provider_ids_deny_insert"   ON card_provider_ids FOR INSERT WITH CHECK (false);
CREATE POLICY "provider_ids_deny_update"   ON card_provider_ids FOR UPDATE USING (false);
CREATE POLICY "provider_ids_deny_delete"   ON card_provider_ids FOR DELETE USING (false);

CREATE INDEX IF NOT EXISTS provider_ids_catalog_idx  ON card_provider_ids(catalog_id);
CREATE INDEX IF NOT EXISTS provider_ids_provider_idx ON card_provider_ids(provider, external_id);

-- ── 5. Per-finish price table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS card_prices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id   TEXT NOT NULL REFERENCES card_catalog(id) ON DELETE CASCADE,
  finish       TEXT NOT NULL DEFAULT 'Normal',
  price_avg7   NUMERIC(10,2),
  price_avg30  NUMERIC(10,2),
  price_low    NUMERIC(10,2),
  price_sell   NUMERIC(10,2),
  price_trend  NUMERIC(10,2),
  cm_url       TEXT,
  source       TEXT DEFAULT 'cardmarket',
  fetched_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(catalog_id, finish)
);

ALTER TABLE card_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prices_public_select" ON card_prices FOR SELECT USING (true);
CREATE POLICY "prices_deny_insert"   ON card_prices FOR INSERT WITH CHECK (false);
CREATE POLICY "prices_deny_update"   ON card_prices FOR UPDATE USING (false);
CREATE POLICY "prices_deny_delete"   ON card_prices FOR DELETE USING (false);

CREATE INDEX IF NOT EXISTS card_prices_catalog_idx ON card_prices(catalog_id);

-- ── 6. Price history (daily snapshots) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id  TEXT NOT NULL REFERENCES card_catalog(id) ON DELETE CASCADE,
  finish      TEXT NOT NULL DEFAULT 'Normal',
  price       NUMERIC(10,2) NOT NULL,
  source      TEXT DEFAULT 'cardmarket',
  recorded_at DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE(catalog_id, finish, recorded_at)
);

ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "history_public_select" ON price_history FOR SELECT USING (true);
CREATE POLICY "history_deny_insert"   ON price_history FOR INSERT WITH CHECK (false);
CREATE POLICY "history_deny_update"   ON price_history FOR UPDATE USING (false);
CREATE POLICY "history_deny_delete"   ON price_history FOR DELETE USING (false);

CREATE INDEX IF NOT EXISTS price_history_catalog_date_idx
  ON price_history(catalog_id, recorded_at DESC);

-- ── 7. Enhance user cards table ───────────────────────────────────────────────
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS condition    TEXT,
  ADD COLUMN IF NOT EXISTS grade        NUMERIC(3,1),
  ADD COLUMN IF NOT EXISTS grader       TEXT,
  ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS price_avg7   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS price_avg30  NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS price_low    NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS price_sell   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS cardmarket_url TEXT;

-- ── 8. Sync state tracker (for workers) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_state (
  id          TEXT PRIMARY KEY,
  last_run    TIMESTAMPTZ,
  last_status TEXT DEFAULT 'idle',
  meta        JSONB DEFAULT '{}'
);

ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sync_state_deny_all" ON sync_state FOR ALL USING (false);

-- ── Done ─────────────────────────────────────────────────────────────────────
-- Run the seed-games script after this to populate sets via providers.
