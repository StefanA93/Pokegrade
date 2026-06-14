import sharp from 'sharp'

export default async function handler(req, res) {
  if (req.query.key !== 'gd_debug_2024') return res.status(403).end()

  const EMBED_URL    = process.env.EMBED_SERVICE_URL?.trim()
  const EMBED_SECRET = process.env.EMBED_SECRET?.trim()

  const results = {
    sharp_ver: null,
    vips_ver:  null,
    sharp_ok:  false,
    png_dl:    null,
    thumb_ok:  false,
    railway:   null,
    embed_len: 0,
  }

  // 1. Versioner
  results.sharp_ver = sharp.versions?.sharp
  results.vips_ver  = sharp.versions?.vips

  // 2. Basic sharp test
  try {
    const out = await sharp({ create: { width: 224, height: 224, channels: 3, background: { r: 100, g: 100, b: 100 } } })
      .jpeg({ quality: 80 }).toBuffer()
    results.sharp_ok = out.length > 100
  } catch (e) { results.sharp_err = e.message }

  // 3. Download real card PNG + thumbnail
  try {
    const r = await fetch('https://images.pokemontcg.io/sm1/1.png', { signal: AbortSignal.timeout(15000) })
    const buf = Buffer.from(await r.arrayBuffer())
    results.png_dl = buf.length

    const norm = await sharp(buf).resize(900).jpeg({ quality: 90 }).toBuffer()
    const thumb = await sharp(norm).resize(224, 224, { fit: 'fill' }).jpeg({ quality: 80 }).toBuffer()
    results.thumb_ok = thumb.length > 1000
    results.thumb_len = thumb.length

    // 4. Send thumbnail to Railway
    if (EMBED_URL && thumb) {
      const b64 = thumb.toString('base64')
      const t0 = Date.now()
      const er = await fetch(`${EMBED_URL}/embed`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${EMBED_SECRET}` },
        body:    JSON.stringify({ image: `data:image/jpeg;base64,${b64}` }),
        signal:  AbortSignal.timeout(25000),
      })
      const ms = Date.now() - t0
      if (er.ok) {
        const { embedding } = await er.json()
        results.railway = `ok_${ms}ms`
        results.embed_len = embedding?.length
      } else {
        const txt = await er.text()
        results.railway = `fail_${er.status}_${ms}ms_${txt.slice(0, 60)}`
      }
    }
  } catch (e) { results.pipeline_err = e.message }

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.status(200).json(results)
}
