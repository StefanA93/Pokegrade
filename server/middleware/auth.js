const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

export async function verifyJWT(request, reply) {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } })
  }

  const token = auth.slice(7)
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_SERVICE_KEY
      }
    })
    if (!res.ok) throw new Error('Invalid token')
    const user = await res.json()
    request.userId = user.id
    request.userEmail = user.email
  } catch {
    return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid session' } })
  }
}

export async function verifyServiceKey(request, reply) {
  const key = request.headers['x-service-key']
  if (key !== process.env.INTERNAL_SERVICE_KEY) {
    return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Service key required' } })
  }
}
