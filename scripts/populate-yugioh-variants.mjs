import 'dotenv/config'
import pg from 'pg'

// YGO variant model = rarities/editions as SEPARATE ROWS (not a finishes-array).
// variant_group_key = the EXACT set-code (number) = "the variants of THIS print" — the same
// semantics as JP's (set_id|number) and EN/MTG's finish_types. Rows sharing a set-code are the
// same physical print in different rarities/treatments (e.g. 25YC-ENP01 plain vs WCQ alt).
// The cross-set "all prints of this card" list (e.g. all 68 Dark Magicians) is NOT this key —
// it is a separate name-search fallback, uniform across all games (used when code-OCR fails).
// YGO set-codes are globally unique per print, so number alone is the right key (NOT set_id|number,
// which would wrongly split a print filed under two set_ids).

const c = new pg.Client({ host: 'aws-1-eu-central-1.pooler.supabase.com', port: 5432, user: 'postgres.yezlcgooutpshqdhvufg', password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
await c.query('SET statement_timeout=0')

const KEY = "lower(coalesce(nullif(number,''), id))"

await c.query('ALTER TABLE card_catalog ADD COLUMN IF NOT EXISTS variant_group_key text')
const upd = await c.query(`UPDATE card_catalog SET variant_group_key = ${KEY} WHERE game='yugioh' AND name IS NOT NULL AND name <> ''`)
console.log(`variant_group_key sat: ${upd.rowCount} yugioh-rækker`)
await c.query('CREATE INDEX IF NOT EXISTS card_catalog_variant_group_idx ON card_catalog (game, variant_group_key)')
console.log('index card_catalog_variant_group_idx OK')

// --- verifikation ---
const cov = (await c.query("SELECT count(*)::int tot, count(variant_group_key)::int keyed, count(DISTINCT variant_group_key)::int groups FROM card_catalog WHERE game='yugioh'")).rows[0]
console.log(`\nDÆKNING: ${cov.keyed}/${cov.tot} keyed | ${cov.groups} distinkte grupper (= tryk)`)

const multi = (await c.query("WITH g AS (SELECT variant_group_key k, count(*)::int rows FROM card_catalog WHERE game='yugioh' GROUP BY 1) SELECT count(*) FILTER (WHERE rows>1)::int multirow, max(rows) mx, round(avg(rows),3) avg FROM g")).rows[0]
console.log(`samme-tryk variant-grupper (>1 række): ${multi.multirow} | max ${multi.mx} | snit ${multi.avg}`)

console.log('\nVariant-gruppe sample — alle rækker under kode 25YC-ENP01 (samme tryk, forskellig behandling):')
const a2 = await c.query("SELECT name, rarity, variant_group_key FROM card_catalog WHERE game='yugioh' AND number='25YC-ENP01' ORDER BY name")
for (const r of a2.rows) console.log(`   key="${r.variant_group_key}"  ${r.rarity}\t${r.name}`)

console.log('\nCross-set fallback (navne-søgning, IKKE variant_group_key) — antal tryk af Dark Magician:')
const ns = await c.query("SELECT count(DISTINCT number)::int prints, count(*)::int rows FROM card_catalog WHERE game='yugioh' AND lower(split_part(name,' (',1))='dark magician'")
console.log(`   ${ns.rows[0].prints} distinkte koder / ${ns.rows[0].rows} rækker (findes via name-search når kode-OCR fejler)`)

console.log('\nFALSK-MERGE-tjek — grupper hvor rækker har >1 DISTINKT base-navn (forventet: ~få errata/rename):')
const fm = await c.query("WITH g AS (SELECT variant_group_key k, count(DISTINCT lower(split_part(name,' (',1)))::int bases, count(*)::int rows FROM card_catalog WHERE game='yugioh' GROUP BY 1) SELECT count(*) FILTER (WHERE bases>1)::int multibase FROM g")
console.log(`   grupper m. >1 base-navn: ${fm.rows[0].multibase}`)

await c.end()
console.log('\nFÆRDIG.')
