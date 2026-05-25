const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    apikey: SUPABASE_SERVICE_KEY,
    ...extra
  }
}

export async function dbSelect(table, params = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params ? `?${params}` : ''}`, {
    headers: headers()
  })
  if (!r.ok) throw new Error(`DB select failed: ${r.status}`)
  return r.json()
}

export async function dbInsert(table, body, { upsert = false, onConflict = '' } = {}) {
  const prefer = upsert
    ? `resolution=merge-duplicates${onConflict ? `,merge-duplicates-on=${onConflict}` : ''}`
    : 'return=representation'
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers({ Prefer: prefer }),
    body: JSON.stringify(body)
  })
  if (!r.ok) {
    const err = await r.text()
    throw new Error(`DB insert failed: ${r.status} ${err}`)
  }
  return r.json()
}

export async function dbUpsert(table, body, onConflict) {
  return dbInsert(table, body, { upsert: true, onConflict })
}

export async function dbUpdate(table, match, body) {
  const qs = Object.entries(match).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&')
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(body)
  })
  if (!r.ok) throw new Error(`DB update failed: ${r.status}`)
  return r.json()
}

export async function dbDelete(table, match) {
  const qs = Object.entries(match).map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`).join('&')
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    method: 'DELETE',
    headers: headers()
  })
  if (!r.ok) throw new Error(`DB delete failed: ${r.status}`)
}

export async function dbCount(table, params = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params ? `?${params}` : ''}`, {
    headers: headers({ Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' })
  })
  const range = r.headers.get('content-range')
  return range ? parseInt(range.split('/')[1] || '0') : 0
}
