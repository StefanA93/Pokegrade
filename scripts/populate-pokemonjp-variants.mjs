import 'dotenv/config'
import pg from 'pg'
// JP Pokemon = HYBRID. Pattern-variants (Mirror Holo, Poke/Master Ball, etc.) are stored as
// SEPARATE ROWS with "(... )" name suffix sharing the base print's number — same rows-grouping
// as YGO. variant_group_key groups them with the base card so Lag 2 can surface the pick-list.
// (The holo finish_types array is a secondary, currently-unreliable axis — handled separately.)
const c = new pg.Client({ host:'aws-1-eu-central-1.pooler.supabase.com', port:5432, user:'postgres.yezlcgooutpshqdhvufg', password:process.env.SUPABASE_DB_PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} })
await c.connect()
await c.query('SET statement_timeout=0')
// JP pattern-variants share the SAME print (set_id + number); group on that, NOT the name —
// name-grouping over-merged number-less trainer names like "Switch" across all sets.
const KEY = "lower(set_id || '|' || coalesce(nullif(number,''), id))"
const upd = await c.query(`UPDATE card_catalog SET variant_group_key = ${KEY} WHERE game='pokemonjp' AND name IS NOT NULL AND name <> ''`)
console.log(`variant_group_key sat: ${upd.rowCount} pokemonjp-rækker`)

// verifikation
const cov = (await c.query("SELECT count(variant_group_key)::int keyed, count(*)::int tot, count(DISTINCT variant_group_key)::int groups FROM card_catalog WHERE game='pokemonjp'")).rows[0]
console.log(`DÆKNING: ${cov.keyed}/${cov.tot} keyed | ${cov.groups} grupper`)
const multi = (await c.query("WITH g AS (SELECT variant_group_key k, count(*)::int rows FROM card_catalog WHERE game='pokemonjp' GROUP BY 1) SELECT count(*) FILTER (WHERE rows>1)::int multirow, max(rows) mx FROM g")).rows[0]
console.log(`grupper m. >1 række (pattern-varianter): ${multi.multirow} | max ${multi.mx}`)
console.log('\nBulbasaur 001/165-gruppen (skal samles under én nøgle):')
const b = await c.query("SELECT name, variant_group_key FROM card_catalog WHERE game='pokemonjp' AND set_name ILIKE 'SV2a%' AND number='001/165' ORDER BY name")
for (const r of b.rows) console.log(`   key="${r.variant_group_key}"  ${r.name}`)
console.log('\nStørste pattern-grupper:')
const top = await c.query("WITH g AS (SELECT variant_group_key k, count(*)::int rows FROM card_catalog WHERE game='pokemonjp' GROUP BY 1) SELECT k, rows FROM g WHERE rows>1 ORDER BY rows DESC LIMIT 5")
for (const r of top.rows) console.log(`   ${r.rows}\t${r.k}`)
await c.end()
console.log('\nFÆRDIG.')
