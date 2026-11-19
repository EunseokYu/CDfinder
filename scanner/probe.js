/* 출처별 접근 진단 — 수동 실행용 */
'use strict';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const q=encodeURIComponent('비틀즈 애비로드');
const tries=[
 ['bj1',`https://api.bunjang.co.kr/api/1/find_v2.json?q=${q}&order=date&page=0&n=20`,{}],
 ['bj2',`https://api.bunjang.co.kr/api/1/find_v2.json?q=${q}&order=date&page=0&n=20&req_ref=search&stat_device=w`,{}],
 ['bj3',`https://api.bunjang.co.kr/api/1/find_v2.json?q=${q}&order=date&page=0&n=20`,{noua:1}],
 ['bj4',`https://api.bunjang.co.kr/api/1/find_v2.json?q=${q}`,{}],
 ['bj5',`https://core-api.bunjang.co.kr/api/1/find_v2.json?q=${q}&order=date&page=0&n=20`,{}],
 ['bjweb',`https://m.bunjang.co.kr/search/products?q=${q}`,{}],
 ['jn',`https://web.joongna.com/search/${q}`,{}],
 ['hm',`https://www.hellomarket.com/search?q=${q}`,{}],
 ['y24',`https://www.yes24.com/Product/Search?domain=ALL&query=${encodeURIComponent('abbey road')}`,{}],
];
(async()=>{for(const [n,u,o] of tries){try{
  const r=await fetch(u,{headers:o.noua?{}:{'user-agent':UA,'accept-language':'ko-KR,ko;q=0.9',accept:'application/json, text/html;q=0.9'},signal:AbortSignal.timeout(20000)});
  const t=await r.text();
  const next=t.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]{0,300})/);
  console.log(`\n=== ${n} ${r.status} ${t.length}B ${r.headers.get('content-type')}`);
  console.log(t.slice(0,400).replace(/\s+/g,' '));
  if(next)console.log('NEXT_DATA:',next[1].slice(0,300));
  for(const k of ['애비','price','seq','productSeq','"pid"','articleSeq','itemPrice','sortDate'])if(t.includes(k)){const i=t.indexOf(k);console.log(`  [${k}]`,t.slice(Math.max(0,i-120),i+200).replace(/\s+/g,' '))}
 }catch(e){console.log(`\n=== ${n} ERROR ${e.message}`)}}})();
