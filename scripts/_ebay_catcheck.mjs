import 'dotenv/config'
import pg from 'pg'
import { readFileSync } from 'fs'

const FILE = process.argv[2] || '_ebay/raw_pokemon_big.jsonl'
const GAME = process.argv[3] || 'pokemon'
const c = new pg.Client({ host:'aws-1-eu-central-1.pooler.supabase.com', port:5432, user:'postgres.yezlcgooutpshqdhvufg', password:process.env.SUPABASE_DB_PASSWORD, database:'postgres', ssl:{rejectUnauthorized:false} })
await c.connect(); await c.query('SET statement_timeout=0')
const rows = readFileSync(FILE,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))
let ok=0, miss=[]
for (const r of rows) {
  const q = `select id from card_catalog
    where game=$3 and position('/' in number)>0
      and substring(split_part(number,'/',1) from '[0-9]+') ~ '^[0-9]+$'
      and (substring(split_part(number,'/',1) from '[0-9]+'))::int = $1
      and (substring(split_part(number,'/',2) from '[0-9]+'))::int = $2
      and embedding is not null limit 1`
  const res = await c.query(q,[parseInt(r.num,10), r.total, GAME])
  if (res.rows.length) ok++; else miss.push(`${r.num}/${r.total} (${(r.title||'').split(' ').slice(0,2).join(' ')})`)
}
console.log(`\nKATALOG-VALIDERING ${FILE} (n=${rows.length}): findes m. embedding: ${ok}/${rows.length}`)
if (miss.length){ console.log(`  mangler (${miss.length}):`); miss.forEach(m=>console.log('   '+m)) }
await c.end()
