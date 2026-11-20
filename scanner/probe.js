/* 진단용: 페이지 원본을 out/에 저장 → 워크플로 아티팩트로 내려받아 구조 확인 */
'use strict';
const fs=require('fs');fs.mkdirSync('out',{recursive:true});
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const targets=JSON.parse(process.env.TARGETS||'[]');
(async()=>{const log=[];for(const [name,url] of targets){try{
  const r=await fetch(url,{headers:{'user-agent':UA,'accept-language':'ko-KR,ko;q=0.9',accept:'text/html,application/json;q=0.9,*/*;q=0.8'},signal:AbortSignal.timeout(25000),redirect:'follow'});
  const buf=Buffer.from(await r.arrayBuffer());fs.writeFileSync(`out/${name}.bin`,buf);
  log.push({name,url,status:r.status,final:r.url,type:r.headers.get('content-type'),bytes:buf.length});
 }catch(e){log.push({name,url,error:e.message})}await new Promise(r=>setTimeout(r,800))}
 fs.writeFileSync('out/_log.json',JSON.stringify(log,null,1));console.log(JSON.stringify(log,null,1));})();
