// Kør SQL mod Supabase Postgres (session-pooler). Brug: node scripts/pg-run.mjs "SQL" | echo "SQL" | node scripts/pg-run.mjs
import 'dotenv/config'
import pg from 'pg'
import { readFileSync } from 'fs'

export function makeClient() {
  return new pg.Client({
    host: 'aws-1-eu-central-1.pooler.supabase.com',
    port: 5432,
    user: `postgres.yezlcgooutpshqdhvufg`,
    password: process.env.SUPABASE_DB_PASSWORD,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  })
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('pg-run.mjs')) {
  const sql = process.argv[2] || readFileSync(0, 'utf8')
  const c = makeClient()
  await c.connect()
  try {
    const r = await c.query(sql)
    if (Array.isArray(r)) r.forEach((x, i) => console.log(`[${i}]`, x.command, x.rowCount ?? '', x.rows?.length ? JSON.stringify(x.rows.slice(0, 20)) : ''))
    else console.log(r.command, r.rowCount ?? '', r.rows?.length ? JSON.stringify(r.rows.slice(0, 20)) : '')
  } finally { await c.end() }
}
