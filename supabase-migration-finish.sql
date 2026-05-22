-- Migration: add finish column to cards table
-- Run this once in the Supabase SQL Editor:
-- https://supabase.com/dashboard/project/yezlcgooutpshqdhvufg/sql

ALTER TABLE cards ADD COLUMN IF NOT EXISTS finish TEXT;
