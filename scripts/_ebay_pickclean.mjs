// Kvalitets-gate for testset-billeder: tag {key:[candidate ids]} → vælg det bedste RENE
// enkelt-kort-foto. Gate: portræt-aspekt 0.66-0.80, max-dim >=700px, og (for valgte) OCR-navn
// optræder <4x (binder-afvisning). Output: bedste id per kort, eller NO-CLEAN.
import sharp from 'sharp'
import { readFileSync } from 'fs'
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36'
const url=id=>`https://i.ebayimg.com/images/g/${id}/s-l1600.webp`
const cands=JSON.parse(readFileSync(process.argv[2],'utf8'))
async function dim(id){
  try{
    const buf=Buffer.from(await(await fetch(url(id),{headers:{'User-Agent':UA},signal:AbortSignal.timeout(15000)})).arrayBuffer())
    const m=await sharp(buf).metadata(); const mx=Math.max(m.width,m.height), ar=m.width/m.height
    return {id,w:m.width,h:m.height,ar:+ar.toFixed(3),ok:(ar>=0.66&&ar<=0.80&&mx>=700)}
  }catch(e){return {id,ok:false,err:e.message.slice(0,20)}}
}
for(const [key,ids] of Object.entries(cands)){
  let picked=null; const tried=[]
  for(const id of ids){
    const d=await dim(id); tried.push(`${id}:${d.ok?'OK':(d.err||d.w+'x'+d.h+'/'+d.ar)}`)
    if(d.ok){picked=d;break}
  }
  console.log(`${key.padEnd(10)} ${picked?'✅ '+picked.id+` (${picked.w}x${picked.h} ar=${picked.ar})`:'❌ NO-CLEAN'}`)
  console.log(`            tried: ${tried.join('  ')}`)
}
