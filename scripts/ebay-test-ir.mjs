import { readFileSync } from 'fs'
import sharp from 'sharp'
const BYPASS='m8N3Uz2ILE3TvJPPbrApokT6OWvVAlOC'
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36'
const DEPLOY='https://gradedex-v2.vercel.app'
const rows=readFileSync('_ebay/raw_pokemon_ir.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l))
const numPart=s=>{const m=String(s).match(/(\d{1,4})/);return m?String(parseInt(m[1])):null}
let ok=0
for(const r of rows){
  try{
    const buf=Buffer.from(await(await fetch(r.src,{headers:{'User-Agent':UA}})).arrayBuffer())
    const b64=(await sharp(buf).resize(1000).jpeg({quality:88}).toBuffer()).toString('base64')
    const res=await fetch(`${DEPLOY}/api/scan-free?x-vercel-protection-bypass=${BYPASS}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:'data:image/jpeg;base64,'+b64,game:'pokemon'})})
    const j=await res.json()
    const top=j.candidates?.[0]
    const tp=top?String(top.number).match(/(\d{1,3})\s*\/\s*(\d{1,3})/):null
    const pass = tp && numPart(tp[1])===numPart(r.num) && parseInt(tp[2])===r.total
    if(pass)ok++
    console.log(`${pass?'✅':'❌'} ${r.title.padEnd(26)} → ${top?.name} [${top?.number}] ocr=${j.ocr?.name||'-'}/${j.ocr?.number||'-'} svc=${j.meta?.ocrSvc}`)
  }catch(e){console.log(`ERR ${r.num}: ${e.message}`)}
  await new Promise(r=>setTimeout(r,1500))
}
console.log(`\n── IR/SIR (Surging Sparks, n=${rows.length}) ──\n  num+total-match: ${Math.round(100*ok/rows.length)}% (${ok}/${rows.length})`)
