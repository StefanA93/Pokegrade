import 'dotenv/config'
import pg from 'pg'

// Lorcana variant model = finishes-array (foil is a property of the card, not a separate row).
// Lorcana's print model is UNIFORM: every standard booster card exists in non-foil AND foil;
// Enchanted = foil-only (the chase). So finish_types is rule-based on rarity (accurate for Lorcana,
// unlike Pokemon's leaky reverse-holo). Prices stay on the existing CM EU pipeline (foil EUR price
// is a separate, source-limited gap — CM API does not split foil/non-foil).

const c = new pg.Client({ host: 'aws-1-eu-central-1.pooler.supabase.com', port: 5432, user: 'postgres.yezlcgooutpshqdhvufg', password: process.env.SUPABASE_DB_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } })
await c.connect()
await c.query('SET statement_timeout=0')

const upd = await c.query(`
  UPDATE card_catalog SET finish_types = CASE
    WHEN rarity = 'Enchanted' THEN ARRAY['Foil']
    WHEN name ~* '[(](cold )?foil[)][[:space:]]*$' THEN ARRAY['Foil']
    WHEN rarity IN ('Common','Uncommon','Rare','Super Rare','Legendary') THEN ARRAY['Normal','Foil']
    ELSE ARRAY['Normal']
  END
  WHERE game='lorcana'`)
console.log(`finish_types sat: ${upd.rowCount} lorcana-rækker`)

const dist = await c.query("SELECT array_to_string(finish_types,'+') ft, count(*)::int n FROM card_catalog WHERE game='lorcana' GROUP BY 1 ORDER BY n DESC")
console.log('\nfinish_types-fordeling:')
for (const r of dist.rows) console.log(`   ${String(r.n).padStart(5)}  ${r.ft}`)
const byRar = await c.query("SELECT rarity, array_to_string(finish_types,'+') ft, count(*)::int n FROM card_catalog WHERE game='lorcana' GROUP BY 1,2 ORDER BY rarity, n DESC")
console.log('\nfinish_types × rarity (sanity):')
let cur=''
for (const r of byRar.rows){ if(r.rarity!==cur){console.log(`  ${r.rarity}:`);cur=r.rarity} console.log(`     ${r.ft}: ${r.n}`) }
await c.end()
console.log('\nFÆRDIG.')
