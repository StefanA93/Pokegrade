import 'dotenv/config'
import pg from 'pg'

// DragonBall variant model = rows (SPR / Gold Stamped / Silver Foil / Alternate Art / Reprint /
// Winner / tournament treatments stored as SEPARATE ROWS sharing the card's number). Same as YGO/OP:
// variant_group_key = number = "the variants of this card". DBS number (BT9-074, P-219) is the card id;
// promo reprints across sets keep it. False-merge verified ~0 (26 multibase, all same card w/ name noise).

const c = new pg.Client({ host: 'aws-1-eu-central-1.pooler.supabase.com', port: 5432, user: 'postgres.yezlcgooutpshqdhvufg', password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
await c.query('SET statement_timeout=0')

const KEY = "lower(coalesce(nullif(number,''), id))"
await c.query('ALTER TABLE card_catalog ADD COLUMN IF NOT EXISTS variant_group_key text')
const upd = await c.query(`UPDATE card_catalog SET variant_group_key = ${KEY} WHERE game='dragonball' AND name IS NOT NULL AND name <> ''`)
console.log(`variant_group_key sat: ${upd.rowCount} dragonball-rækker`)

const cov = (await c.query("SELECT count(*)::int tot, count(variant_group_key)::int keyed, count(DISTINCT variant_group_key)::int groups FROM card_catalog WHERE game='dragonball'")).rows[0]
console.log(`DÆKNING: ${cov.keyed}/${cov.tot} keyed | ${cov.groups} grupper (= kort)`)
const multi = (await c.query("WITH g AS (SELECT variant_group_key k, count(*)::int rows FROM card_catalog WHERE game='dragonball' GROUP BY 1) SELECT count(*) FILTER (WHERE rows>1)::int multirow, max(rows) mx, round(avg(rows),3) avg FROM g")).rows[0]
console.log(`variant-grupper (>1 række): ${multi.multirow} | max ${multi.mx} | snit ${multi.avg}`)
console.log('\nSample — P-219 (SS2 Trunks) varianter samlet:')
const s = await c.query("SELECT name, rarity, variant_group_key FROM card_catalog WHERE game='dragonball' AND number='P-219' ORDER BY name LIMIT 8")
for (const r of s.rows) console.log(`   key="${r.variant_group_key}"  ${r.rarity}\t${r.name}`)
await c.end()
console.log('\nFÆRDIG.')
