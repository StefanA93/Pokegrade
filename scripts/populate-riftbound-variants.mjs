import 'dotenv/config'
import pg from 'pg'

// Riftbound variant model = rows, grouped by NAME. Unlike YGO/OP/DBS, Riftbound `number` is unusable
// as a key (junk codes like OGN/SFDX shared by 20+ different cards, and the same card is reprinted
// across every set with different numbers). The card's NAME is its identity; showcase/Signed Showcase
// variants + cross-set reprints share the name (e.g. "Body Rune" = Common + 5 showcases across sets).
// So variant_group_key = base name. (Foil is a finishes-axis with no available source → not populated.)

const c = new pg.Client({ host: 'aws-1-eu-central-1.pooler.supabase.com', port: 5432, user: 'postgres.yezlcgooutpshqdhvufg', password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
await c.query('SET statement_timeout=0')

const KEY = "lower(trim(split_part(name,' (',1)))"
await c.query('ALTER TABLE card_catalog ADD COLUMN IF NOT EXISTS variant_group_key text')
const upd = await c.query(`UPDATE card_catalog SET variant_group_key = ${KEY} WHERE game='riftbound' AND name IS NOT NULL AND name <> ''`)
console.log(`variant_group_key sat: ${upd.rowCount} riftbound-rækker`)

const cov = (await c.query("SELECT count(*)::int tot, count(variant_group_key)::int keyed, count(DISTINCT variant_group_key)::int groups FROM card_catalog WHERE game='riftbound'")).rows[0]
console.log(`DÆKNING: ${cov.keyed}/${cov.tot} keyed | ${cov.groups} grupper (= kort)`)
const multi = (await c.query("WITH g AS (SELECT variant_group_key k, count(*)::int rows FROM card_catalog WHERE game='riftbound' GROUP BY 1) SELECT count(*) FILTER (WHERE rows>1)::int multirow, max(rows) mx, round(avg(rows),3) avg FROM g")).rows[0]
console.log(`variant-grupper (>1 række): ${multi.multirow} | max ${multi.mx} | snit ${multi.avg}`)
console.log('\nSample — "Body Rune" varianter samlet:')
const s = await c.query("SELECT name, number, rarity, variant_group_key FROM card_catalog WHERE game='riftbound' AND variant_group_key='body rune' ORDER BY rarity, number")
for (const r of s.rows) console.log(`   key="${r.variant_group_key}"  ${r.number}\t${r.rarity}\t${r.name}`)
await c.end()
console.log('\nFÆRDIG.')
