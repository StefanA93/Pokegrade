/**
 * Rens et YGO-testsæt: fjern dårlig framing (lav-opløsning/letterbox/kvadrat) + bekræftede fejl-labels.
 * Bygger kvalitets-gaten ind (framing objektivt her; label-verifikation via _ebay/testset_gate.py før-trin).
 * Kør: node scripts/clean-testset.mjs
 * Ud: _ebay/raw_yugioh_clean.jsonl (rene) + _ebay/ygo_quarantine.jsonl (fjernede m. årsag).
 */
import { readFileSync, writeFileSync } from 'fs'
import sharp from 'sharp'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
// Bekræftede fejl-labels (billedet er et ANDET kort — verificeret via testset_gate OCR)
const MISLABELS = new Set(['LOB-EN053', 'HAC1-EN008', 'SGX1-EN101', 'L5DD-ENC01', 'TN23-EN002',
  'YGLD-ENG02', 'YGLD-ENG03', 'YGLD-ENB09', 'YGLD-ENB17', 'RA01-EN040'])

const test = readFileSync('_ebay/raw_yugioh.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l))
const clean = [], quarantine = []
let i = 0
for (const t of test) {
  let reason = null
  if (MISLABELS.has(t.number)) reason = 'fejl-label'
  else {
    try {
      const { width: w, height: h } = await sharp(Buffer.from(await (await fetch(t.src, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })).arrayBuffer())).metadata()
      const asp = w / h
      if (w < 900 || h < 900) reason = `lav-opløsning ${w}x${h}`
      else if (asp < 0.64 || asp > 0.80) reason = `framing asp${asp.toFixed(2)}`
    } catch { reason = 'fetch-fejl' }
  }
  if (reason) quarantine.push({ ...t, _quarantine: reason })
  else clean.push(t)
  if (++i % 40 === 0) process.stderr.write(`\r  ${i}/${test.length}`)
}
writeFileSync('_ebay/raw_yugioh_clean.jsonl', clean.map(o => JSON.stringify(o)).join('\n') + '\n')
writeFileSync('_ebay/ygo_quarantine.jsonl', quarantine.map(o => JSON.stringify(o)).join('\n') + '\n')
console.log(`\n✅ rent testsæt: ${clean.length} kort → _ebay/raw_yugioh_clean.jsonl`)
console.log(`   quarantine: ${quarantine.length} (${quarantine.filter(q => q._quarantine === 'fejl-label').length} fejl-labels + ${quarantine.filter(q => q._quarantine !== 'fejl-label').length} framing) → _ebay/ygo_quarantine.jsonl`)
