'use strict';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const q=encodeURIComponent('비틀즈 애비로드');
const H={'user-agent':UA,'accept-language':'ko-KR,ko;q=0.9'};
const get=(u,h={})=>fetch(u,{headers:{...H,...h},signal:AbortSignal.timeout(20000)});
(async()=>{
 for(const [n,u,h] of [
  ['bjA',`https://api.bunjang.co.kr/api/1/find_v2.json?q=${q}&order=score&page=0&n=20&req_ref=search&stat_device=w&version=5`,{origin:'https://m.bunjang.co.kr',referer:'https://m.bunjang.co.kr/'}],
  ['bjB',`https://api.bunjang.co.kr/api/1/find_v2.json?q=${q}&order=date&page=0&n=20`,{origin:'https://globalbunjang.com',referer:'https://globalbunjang.com/'}],
  ['bjC',`https://api.bunjang.co.kr/api/pms/v2/products-detail/147682520?viewerUid=-1`,{}],
  ['bjD',`https://api.bunjang.co.kr/api/1/product/147682520/detail_info.json?version=4`,{}],
  ['bjE',`https://globalbunjang.com/search?q=${q}`,{}],
 ]){try{const r=await get(u,h);const t=await r.text();console.log(`\n=== ${n} ${r.status} ${t.length}B`);console.log(t.slice(0,600).replace(/\s+/g,' '))}catch(e){console.log(`\n=== ${n} ERR ${e.message}`)}}
 // 중고나라: 첫 상품 객체 전체
 try{const t=await (await get(`https://web.joongna.com/search/${q}`)).text();
  const s=t.replace(/\\"/g,'"');let i=s.indexOf('"title":"비틀즈 THE BEATLES');if(i<0)i=s.indexOf('애비로드 CD');
  console.log('\n=== JN item\n'+s.slice(Math.max(0,i-900),i+700));
  const m=s.match(/"totalSize":\d+|"total(Count|Size|Cnt)":\d+/);console.log('JN total',m&&m[0]);
 }catch(e){console.log('JN ERR',e.message)}
 try{const t=await (await get(`https://www.hellomarket.com/search?q=${q}`)).text();
  const j=JSON.parse(t.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)[1]);
  const find=(o,p='')=>{if(Array.isArray(o)&&o[0]&&o[0].idx&&o[0].price!==undefined){console.log('HM path',p,'len',o.length);console.log(JSON.stringify(o[0]).slice(0,900));return true}
   if(o&&typeof o==='object')for(const k in o)if(find(o[k],p+'.'+k))return true;return false};find(j);
 }catch(e){console.log('HM ERR',e.message)}
})();
