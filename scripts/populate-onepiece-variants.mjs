import 'dotenv/config'
import pg from 'pg'

// OnePiece variant model = rows (Alternate Art / Parallel / Manga / SP / Pirate Foil / Reprint /
// Gold/Silver etc. stored as SEPARATE ROWS sharing the card's number). variant_group_key = number
// = "the variants of this card" (same semantics as YGO). OnePiece number (OP09-004) is the card id;
// reprints across sets keep it → grouping across sets is correct (same card, different treatment).
// False-merge verified ~0 (only 2 number-groups with >1 base-name, both same card w/ name noise).

const c = new pg.Client({ host: 'aws-1-eu-central-1.pooler.supabase.com', port: 5432, user: 'postgres.yezlcgooutpshqdhvufg', password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
await c.query('SET statement_timeout=0')

const KEY = "lower(coalesce(nullif(number,''), id))"
await c.query('ALTER TABLE card_catalog ADD COLUMN IF NOT EXISTS variant_group_key text')
const upd = await c.query(`UPDATE card_catalog SET variant_group_key = ${KEY} WHERE game='onepiece' AND name IS NOT NULL AND name <> ''`)
console.log(`variant_group_key sat: ${upd.rowCount} onepiece-rækker`)

const cov = (await c.query("SELECT count(*)::int tot, count(variant_group_key)::int keyed, count(DISTINCT variant_group_key)::int groups FROM card_catalog WHERE game='onepiece'")).rows[0]
console.log(`DÆKNING: ${cov.keyed}/${cov.tot} keyed | ${cov.groups} grupper (= kort)`)
const multi = (await c.query("WITH g AS (SELECT variant_group_key k, count(*)::int rows FROM card_catalog WHERE game='onepiece' GROUP BY 1) SELECT count(*) FILTER (WHERE rows>1)::int multirow, max(rows) mx, round(avg(rows),3) avg FROM g")).rows[0]
console.log(`variant-grupper (>1 række): ${multi.multirow} | max ${multi.mx} | snit ${multi.avg}`)
console.log('\nSample — OP09-004 (Shanks) varianter samlet:')
const s = await c.query("SELECT name, rarity, variant_group_key FROM card_catalog WHERE game='onepiece' AND number='OP09-004' ORDER BY name")
for (const r of s.rows) console.log(`   key="${r.variant_group_key}"  ${r.rarity}\t${r.name}`)
await c.end()
console.log('\nFÆRDIG.')
