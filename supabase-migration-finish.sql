-- Run in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/yezlcgooutpshqdhvufg/sql

ALTER TABLE cards ADD COLUMN IF NOT EXISTS thumb_key TEXT;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS rarity     TEXT;
