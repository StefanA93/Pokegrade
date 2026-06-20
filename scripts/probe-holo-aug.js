/**
 * Holo-probe: tester om katalog-side augmentering (simuleret glare/lysstyrke) flytter
 * katalog-renderens embedding TÆTTERE på et ægte holo-foto. Hvis ja → augmentering er fixet.
 *
 * Pr. kort: embed (a) eBay-holo-foto, (b) flad katalog-render, (c) flere augmenterede
 * katalog-varianter. Mål cosine(eBay, hver katalog-variant). Hvis en augmenteret variant
 * scorer markant højere end den flade render, vil lagring af augmenterede embeddings hjælpe.
 */
import 'dotenv/config'
import sharp from 'sharp'

const RWY = 'https://pokegrade-production-683f.up.railway.app', RSEC = 'gd_embed_2024'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36'

// holo-fejl-kort: [eBay-num, eBay-foto, katalog-render]
const CARDS = [
  ['82 Galarian Zapdos (holo)',  'https://i.ebayimg.com/images/g/BZsAAeSwPUpn999g/s-l960.webp', 'https://images.pokemontcg.io/swsh7/82_hires.png'],
  ['67 Sableye (reverse-holo)',  'https://i.ebayimg.com/images/g/xjsAAeSwsa1qLBB1/s-l960.webp', 'https://images.pokemontcg.io/swsh7/67_hires.png'],
  ['63 Gardevoir',               'https://i.ebayimg.com/images/g/UEwAAOSwl01kEbVf/s-l960.webp', 'https://images.pokemontcg.io/swsh7/63_hires.png'],
]

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
const norm = a => Math.sqrt(dot(a, a))
const cos = (a, b) => dot(a, b) / (norm(a) * norm(b))

async function embed(buf) {
  const b64 = (await sharp(buf).resize(800, 800, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer()).toString('base64')
  const r = await fetch(`${RWY}/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RSEC}` },
    body: JSON.stringify({ image: `data:image/jpeg;base64,${b64}`, game: 'pokemon' }), signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error('Railway ' + r.status)
  return (await r.json()).embedding
}
const dl = async (url, headers = {}) => Buffer.from(await (await fetch(url, { headers })).arrayBuffer())

// Augmenteringer der simulerer holo/foto: lysstyrke, kontrast-vask, gamma, retnings-glare-ramp.
async function glareRamp(buf, dir = 'horizontal') {
  const img = sharp(buf), meta = await img.metadata()
  const W = meta.width, H = meta.height
  // hvid gradient-overlay (lineær specular highlight) blendet oven på kortet
  const grad = Buffer.from(
    `<svg width="${W}" height="${H}"><defs><linearGradient id="g" ${dir === 'horizontal' ? 'x1="0" x2="1" y1="0" y2="0"' : 'x1="0" x2="0" y1="0" y2="1"'}>
      <stop offset="0" stop-color="white" stop-opacity="0.45"/><stop offset="0.5" stop-color="white" stop-opacity="0.05"/>
      <stop offset="1" stop-color="white" stop-opacity="0.40"/></linearGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#g)"/></svg>`)
  return img.composite([{ input: grad, blend: 'over' }]).toBuffer()
}
const AUGS = {
  'flad (baseline)':  async b => b,
  'bright +30%':      async b => sharp(b).modulate({ brightness: 1.30 }).toBuffer(),
  'lavkontrast-vask': async b => sharp(b).linear(0.75, 35).toBuffer(),
  'gamma 0.6':        async b => sharp(b).gamma(2.2).toBuffer(),
  'glare-ramp-H':     async b => glareRamp(b, 'horizontal'),
  'glare-ramp-V':     async b => glareRamp(b, 'vertical'),
  'glare+bright':     async b => sharp(await glareRamp(b, 'horizontal')).modulate({ brightness: 1.2, saturation: 0.85 }).toBuffer(),
}

for (const [name, ebayUrl, catUrl] of CARDS) {
  console.log(`\n━━ ${name} ━━`)
  const ebayBuf = await dl(ebayUrl, { 'User-Agent': UA })
  const catBuf = await dl(catUrl)
  const eEmb = await embed(ebayBuf)
  let best = { name: '', cos: -1 }
  for (const [aug, fn] of Object.entries(AUGS)) {
    const cEmb = await embed(await fn(catBuf))
    const c = cos(eEmb, cEmb)
    if (c > best.cos) best = { name: aug, cos: c }
    console.log(`  cos(eBay, ${aug.padEnd(18)}) = ${c.toFixed(4)}`)
  }
  console.log(`  → bedste: "${best.name}" (${best.cos.toFixed(4)})`)
}
