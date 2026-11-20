/* cdfinder 웹앱 — data/db.json(GitHub)을 읽고, 토큰이 있으면 수정 사항을 커밋한다. 판단·통계는 engine.js. */
{
'use strict';
/* ========== 상수 ========== */
const STATUS=['판매중','판매완료','품절','숨김','미확인'];
const SOURCES=['알라딘','YES24','번개장터','중고나라','음반점','기타'];
const PACK=['주얼케이스','디지팩','페이퍼슬리브','박스세트','기타','미확인'];
const RELEASE=['초판','재발매','미확인'],MASTER=['리마스터','기존 마스터','미확인'];
const AUTH=['확인됨','미확인','의심'],MATCH=['일치','미확인','불일치'];
const GRADES=[['S','S 최상'],['A','A 양호'],['B','B 보통'],['C','C 사용감 많음'],['미확인','상태 미확인']];
const BGRADES=[...GRADES.slice(0,4),['누락','북클릿 누락'],['미확인','상태 미확인']];
const ALLOW=[['S','S 이상'],['A','A 이상'],['B','B 이상'],['C','C 이상'],['ANY','상관없음']];
const PARTS=Engine.PARTS;
const V={'구매 추천':['v-buy','✓',0],'관망':['v-wait','…',1],'비추천':['v-no','✕',2],'판매 확인 필요':['v-check','?',3],'제외':['v-out','—',4]};
const CRIT0=()=>({kind:'중고',target:null,disc:'ANY',case:'ANY',booklet:'ANY',requireAuth:false});

/* ========== 유틸 ========== */
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const won=n=>n==null?'미확인':n.toLocaleString('ko-KR')+'원';
const pad=n=>String(n).padStart(2,'0');
const dt=t=>{if(!t)return'기록 없음';const d=new Date(t);return `${d.getMonth()+1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`};
const ago=t=>{if(!t)return'기록 없음';const m=Math.round((Date.now()-t)/60000);return m<1?'방금':m<60?`${m}분 전`:m<1440?`${Math.round(m/60)}시간 전`:`${Math.round(m/1440)}일 전`};
const today=()=>{const d=new Date();return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`};
const uid=p=>p+'-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const list=s=>String(s||'').split(',').map(x=>x.trim()).filter(Boolean);
const safeUrl=u=>/^https?:\/\//i.test(u||'')?u:null;
const ls={get(k){try{return localStorage.getItem(k)}catch{return null}},set(k,v){try{localStorage.setItem(k,v)}catch{}}};

/* ========== GitHub 저장소 (입력부) ========== */
const cfg=Object.assign({owner:'EunseokYu',repo:'CDfinder',branch:'main',token:'',remember:true},JSON.parse(ls.get('cdfinder.cfg')||'{}'));
const persistCfg=()=>ls.set('cdfinder.cfg',JSON.stringify({...cfg,token:cfg.remember?cfg.token:''}));
const b64dec=b=>new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g,'')),c=>c.charCodeAt(0)));
const b64enc=s=>{const u=new TextEncoder().encode(s);let x='';for(let i=0;i<u.length;i+=0x8000)x+=String.fromCharCode(...u.subarray(i,i+0x8000));return btoa(x)};
const Remote={
  api:p=>`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/${p}`,
  hd:()=>({Authorization:'Bearer '+cfg.token,Accept:'application/vnd.github+json'}),
  async load(){
    if(cfg.token){
      const r=await fetch(Remote.api(`contents/data/db.json?ref=${cfg.branch}&t=${Date.now()}`),{headers:Remote.hd(),cache:'no-store'});
      if(!r.ok)throw new Error(r.status===401?'토큰이 올바르지 않거나 만료됨':`GitHub 응답 ${r.status}`);
      const j=await r.json();let b=j.content;
      if(!b){const r2=await fetch(Remote.api(`git/blobs/${j.sha}`),{headers:Remote.hd()});b=(await r2.json()).content}
      return{db:JSON.parse(b64dec(b)),sha:j.sha};
    }
    const r=await fetch(`https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/data/db.json?t=${Date.now()}`,{cache:'no-store'});
    if(!r.ok)throw new Error(`데이터 파일 응답 ${r.status}`);
    return{db:await r.json(),sha:null};
  },
  async fileSha(path){const r=await fetch(Remote.api(`contents/${path}?ref=${cfg.branch}&t=${Date.now()}`),{headers:Remote.hd(),cache:'no-store'});if(r.status===404)return null;if(!r.ok)throw new Error(`GitHub 응답 ${r.status}`);return(await r.json()).sha},
  async putFile(path,obj,msg){const sha=await Remote.fileSha(path);const r=await fetch(Remote.api(`contents/${path}`),{method:'PUT',headers:Remote.hd(),body:JSON.stringify({message:'app: '+msg,content:b64enc(JSON.stringify(obj,null,1)+'\n'),branch:cfg.branch,...(sha?{sha}:{})})});if(!r.ok)throw new Error(`GitHub 응답 ${r.status}`)},
  async delFile(path,msg){const sha=await Remote.fileSha(path);if(!sha)return;const r=await fetch(Remote.api(`contents/${path}`),{method:'DELETE',headers:Remote.hd(),body:JSON.stringify({message:'app: '+msg,sha,branch:cfg.branch})});if(!r.ok)throw new Error(`GitHub 응답 ${r.status}`)},
  async getLock(){const r=await fetch(`https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/data/lock.json?t=${Date.now()}`,{cache:'no-store'});if(r.status===404)return null;if(!r.ok)throw new Error(`잠금 파일 응답 ${r.status}`);return r.json()},
  async put(db,sha,msg){
    const r=await fetch(Remote.api('contents/data/db.json'),{method:'PUT',headers:Remote.hd(),body:JSON.stringify({message:'app: '+msg,content:b64enc(JSON.stringify(db,null,1)+'\n'),sha,branch:cfg.branch})});
    if(r.status===409||r.status===422)return false;
    if(!r.ok)throw new Error(r.status===403||r.status===404?'토큰에 이 저장소 쓰기 권한(Contents: Read and write)이 없음':`GitHub 응답 ${r.status}`);
    return true;
  }
};
/* 사지방용 암호 잠금: 토큰을 암호로 암호화해 data/lock.json에 보관 (PBKDF2-SHA256 60만 회 → AES-GCM 256) */
const LOCK_ITER=600000,MIN_PASS=16;
const u8b64=u=>{let x='';for(const c of u)x+=String.fromCharCode(c);return btoa(x)},b64u8=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function lockKey(pass,salt,iter){const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(pass.normalize('NFC')),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:iter,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
async function makeLock(token,pass){const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await lockKey(pass,salt,LOCK_ITER),new TextEncoder().encode(token)));
  return{v:1,kdf:'PBKDF2-SHA256',iter:LOCK_ITER,cipher:'AES-GCM-256',salt:u8b64(salt),iv:u8b64(iv),ct:u8b64(ct),createdAt:Date.now()}}
async function openLock(lock,pass){try{const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64u8(lock.iv)},await lockKey(pass,b64u8(lock.salt),lock.iter),b64u8(lock.ct));return new TextDecoder().decode(pt)}catch{return null}}
let lockInfo=undefined;
async function checkLock(){try{lockInfo=await Remote.getLock()}catch{lockInfo=undefined}renderHeaderOnly()}
let S=null,loadErr='',saving=false;
try{S=JSON.parse(ls.get('cdfinder.cache')||'null')}catch{}
async function refresh(quiet){
  if(saving)return;
  try{const{db}=await Remote.load();S=db;loadErr='';ls.set('cdfinder.cache',JSON.stringify(db));if(!document.querySelector('#modal .ov'))render();else renderHeaderOnly()}
  catch(e){loadErr='최신 데이터를 불러오지 못함: '+e.message;if(!quiet)render()}
}
/* 모든 수정: 최신 db를 받아 fn을 적용하고 커밋. 동시에 수집기가 커밋했으면 다시 받아서 재적용 */
async function save(fn,msg){
  if(!cfg.token)return'‘GitHub 연결’에서 토큰을 먼저 설정해야 저장됩니다.';
  saving=true;toast('저장 중…',true);
  try{
    for(let i=0;i<4;i++){
      const{db,sha}=await Remote.load();
      const r=fn(db);if(typeof r==='string')return r;
      if(await Remote.put(db,sha,msg)){S=db;ls.set('cdfinder.cache',JSON.stringify(db));render();toast(msg+' — GitHub에 저장했습니다.');return}
    }
    return'수집기와 동시에 저장되어 충돌했습니다. 잠시 뒤 다시 시도하세요.';
  }catch(e){return'저장 실패: '+e.message}
  finally{saving=false}
}

/* ========== 화면 상태 ========== */
const UI={tab:'wish',view:'list',albumId:null,editionId:null,q:'',oq:'',f:{source:'',region:'',kind:'',verdict:''}};
const $=s=>document.querySelector(s);
const albumEds=(a,db=S)=>db.editions.filter(e=>e.albumId===a.id);
const activeEds=(a,db=S)=>albumEds(a,db).filter(e=>e.wanted&&!e.ended);
const edListings=ed=>S.listings.filter(l=>l.editionId===ed.id);
const cardEd=a=>{const act=activeEds(a);return act.find(e=>e.id===a.selEd)||act[0]||null};
const fActive=()=>Object.values(UI.f).some(Boolean);
const norm=s=>String(s).toLowerCase().replace(/\s+/g,'');
const qMatch=(a,q)=>!q||[a.title,a.artist,...(a.titleAliases||[]),...(a.artistAliases||[])].some(x=>norm(x).includes(norm(q)))||norm(a.artist+a.title).includes(norm(q));
function lMatch(l,ed){const f=UI.f,v=Engine.judge(l,ed).v;
  if(f.source&&l.source!==f.source)return false;if(f.region&&l.region!==f.region)return false;if(f.kind&&l.kind!==f.kind)return false;
  return f.verdict?v===f.verdict:v!=='제외'}
const vb=v=>`<span class="vb ${V[v][0]}"><span aria-hidden="true">${V[v][1]}</span>${esc(v)}</span>`;
const opt=(arr,val)=>arr.map(x=>{const[v,t]=Array.isArray(x)?x:[x,x];return`<option value="${esc(v)}"${String(v)===String(val??'')?' selected':''}>${esc(t)}</option>`}).join('');
const edChips=e=>`<span class="chips"><span class="chip">발매: ${esc(e.release)}</span><span class="chip">마스터링: ${esc(e.mastering)}</span>${e.year?`<span class="chip">${e.year}</span>`:''}</span>`;

/* ========== 렌더 ========== */
function head(){
  const m=S&&S.meta||{};
  const ST={ok:'정상',partial:'일부 실패',failed:'실패',skipped:'꺼짐',waiting:'대기'};
  const srcs=Object.entries(m.sources||{}).filter(([k])=>!k.startsWith('store:'));const stores=Object.entries(m.sources||{}).filter(([k])=>k.startsWith('store:'));
  const src=[...srcs.map(([,s])=>`${esc(s.label)} ${ST[s.state]||'?'}`),stores.length?`음반점 ${stores.filter(([,s])=>s.state==='ok'||s.state==='partial').length}/${stores.length}곳 정상`:''].filter(Boolean).join(' · ');
  return`<header class="top" id="hdr"><div class="wrap hrow"><h1>음반 탐색 노트</h1>
  <nav class="tabs" role="tablist" aria-label="화면 전환"><button role="tab" data-act="tab" data-v="wish" aria-selected="${UI.tab==='wish'}">사고 싶은 음반</button><button role="tab" data-act="tab" data-v="owned" aria-selected="${UI.tab==='owned'}">보유 음반 (${S?S.collection.length:0})</button></nav></div>
  <div class="wrap scanbar"><span>마지막 자동 스캔 <b>${m.lastScan?ago(m.lastScan):'아직 없음'}</b>${m.lastHourly?` (전체 판매처 ${ago(m.lastHourly)})`:''}${src?` · ${src}`:''}</span>
  <span class="acts"><button data-act="refresh">새로고침</button>${!cfg.token&&lockInfo?'<button class="pri" data-act="unlock">암호로 잠금 해제</button>':''}<button data-act="cfg">${cfg.token?'GitHub 연결됨':'GitHub 연결'}</button></span></div></header>`;
}
function renderHeaderOnly(){const h=$('#hdr');if(h)h.outerHTML=head()}
function render(){
  if(!S){$('#app').innerHTML=head()+`<main class="wrap"><p class="${loadErr?'warn':'note'}">${esc(loadErr||'데이터를 불러오는 중…')}</p></main>`;return}
  $('#app').innerHTML=head()+`<main class="wrap">${loadErr?`<p class="warn">${esc(loadErr)} — 마지막으로 받은 데이터를 보여줍니다.</p>`:''}
  ${cfg.token?'':`<p class="warn">읽기 전용입니다. 저장하려면 ${lockInfo?'‘암호로 잠금 해제’를 누르고 암호를 입력하세요.':'‘GitHub 연결’에서 토큰을 설정하세요.'}</p>`}
  <p class="note">자동 수집 매물은 개별 상품 원본에서 가격·재고·배송비를 확인한 경우에만 최저가와 추천에 들어갑니다. 정품·상태는 원문에 근거가 있을 때만 표시합니다.</p>
  ${UI.tab==='owned'?ownedView():UI.view==='detail'?detailView():listView()}</main>`;
}
function alertsBox(){
  const al=(S.alerts||[]).slice(-8).reverse();if(!al.length)return'';
  return`<section class="box alerts" aria-label="싼 매물 알림"><b>싼 매물 알림</b> <span class="sub">최근 ${al.length}건 · 목표가 이하 또는 참고 시세보다 20% 이상 쌈</span>
  <ul>${al.map(a=>{const l=S.listings.find(x=>x.id===a.listingId),st=l?Engine.last(l).status:'';return`<li><b>${won(a.value)}</b>${a.shippingKnown?'':' + 배송비 미확인'} · ${esc(a.album)} · ${esc(a.source)} · ${esc(a.why.join(', '))} <span class="sub">(${ago(a.at)}${st&&st!=='판매중'?` · 현재 ${esc(st)}`:''})</span> ${safeUrl(a.url)?`<a href="${esc(a.url)}" target="_blank" rel="noopener">원문 열기</a>`:''}</li>`}).join('')}</ul></section>`;
}
function listView(){
  const regions=[...new Set(S.listings.map(l=>l.region))].sort();
  return alertsBox()+`<section class="tool" aria-label="검색과 필터">
  <label class="fld">앨범명·아티스트 검색<input id="q" type="search" value="${esc(UI.q)}" placeholder="예: Abbey, 백예린" autocomplete="off"></label>
  <div class="frow">
   <label>출처<select data-f="source"><option value="">전체</option>${opt(SOURCES,UI.f.source)}</select></label>
   <label>지역<select data-f="region"><option value="">전체</option>${opt(regions,UI.f.region)}</select></label>
   <label>신품/중고<select data-f="kind"><option value="">전체</option>${opt(['신품','중고'],UI.f.kind)}</select></label>
   <label>구매 판단<select data-f="verdict"><option value="">전체 (제외 숨김)</option>${opt(Object.keys(V),UI.f.verdict)}</select></label></div>
  <div class="acts"><button data-act="clearf">검색·필터 초기화</button><button class="pri" data-act="addAlbum">탐색할 앨범 추가</button></div></section>
  <div id="results">${results()}</div>`;
}
function results(){
  const pri=[],rest=[],done=[];
  for(const a of S.albums){if(!qMatch(a,UI.q))continue;const act=activeEds(a);
    if(albumEds(a).length&&!act.length){if(!fActive())done.push(a);continue}
    let m=null;if(fActive()){m=act.flatMap(e=>edListings(e).filter(l=>lMatch(l,e)));if(!m.length)continue}
    (a.priority?pri:rest).push([a,m])}
  if(!pri.length&&!rest.length&&!done.length)return`<p class="empty">조건에 맞는 앨범이 없습니다.</p>`;
  let h='';
  if(pri.length)h+=`<h2>우선 탐색 <small>${pri.length}개</small></h2><div class="grid">${pri.map(x=>card(...x)).join('')}</div>`;
  if(rest.length)h+=`<h2>그 밖의 희망 음반 <small>${rest.length}개</small></h2><div class="grid">${rest.map(x=>card(...x)).join('')}</div>`;
  if(done.length)h+=`<details><summary>탐색 중인 판본이 없는 앨범 ${done.length}개 (스캔하지 않음)</summary><div class="grid" style="margin-top:8px">${done.map(a=>`<article class="card"><h3>${esc(a.title)}</h3><p class="artist">${esc(a.artist)}</p><button data-act="open" data-id="${a.id}">판본 보기·탐색 재개</button></article>`).join('')}</div></details>`;
  return h;
}
/* 앨범별 조회 범위: 성공·실패를 0건과 구분 */
function coverage(a){
  const cov=(S.meta&&S.meta.coverage&&S.meta.coverage[a.id])||{},srcs=(S.meta&&S.meta.sources)||{};
  const name=k=>k.startsWith('store:')?'음반점':(srcs[k]&&srcs[k].label)||k;
  const ok=new Set(),fail=new Set();let stOk=0,stAll=0;
  for(const[k,v]of Object.entries(cov)){if(k.startsWith('store:')){stAll++;if(v.ok)stOk++;continue}(v.ok?ok:fail).add(name(k))}
  for(const[k,v]of Object.entries(srcs))if(v.state==='skipped'&&!k.startsWith('store:'))fail.add(v.label);
  if(stAll)(stOk?ok:fail).add(`음반점 ${stOk}/${stAll}곳`);
  return{ok:[...ok],fail:[...fail].filter(x=>!ok.has(x)),any:Object.keys(cov).length>0};
}
function bestBox(a,ed){
  const k=ed.criteria.kind,b=Engine.best(S,ed,k,'배송'),bh=Engine.best(S,ed,k,'현장'),cv=coverage(a);
  const scope=`<p class="meta">확인한 곳: ${esc(cv.ok.join('·')||'없음')}${cv.fail.length?` · 확인 불가: ${esc(cv.fail.join('·'))}`:''}</p>`;
  const row=(x,label)=>{const u=safeUrl(x.l.url);return`<div class="best"><span class="sub">${label}</span><strong>${won(x.tot)}</strong>
    <span>${esc(x.l.source)}${x.l.shop&&x.l.shop!==x.l.source?` · ${esc(x.l.shop)}`:''}${x.l.delivery==='현장'?` · ${esc(x.l.region)}`:''}</span><span class="sub">${esc(x.why)} · 평균 ${won(x.avg)} (${x.count}건) · 검증 ${dt(x.at)}</span>
    ${u?`<a class="btn" href="${esc(u)}" target="_blank" rel="noopener">상품 보기</a>`:''}</div>`};
  if(!b&&!bh){const msg=!cv.any?'아직 조회 전':!cv.ok.length?'현재 판매 여부 확인 불가':'확인된 매물 없음';return`<div class="best none"><strong>${msg}</strong></div>${scope}`}
  return(b?row(b,`확인된 최저가 · ${esc(k)} · 배송 포함`):'')+(bh?row(bh,`매장 수령 최저가 · ${esc(k)}`):'')+scope;
}
function statDl(ed,k){
  const st=Engine.stats(S,ed,k,null,'배송'),ch=Engine.change(S,ed,k,'배송');
  return`<dl class="st"><div><dt>최저가 (배송, 검증)</dt><dd class="big">${st.count?won(st.min):'—'}</dd></div><div><dt>평균가 (검증)</dt><dd class="big">${st.count?won(st.avg):'—'}</dd></div>
  <div><dt>최근 최저가 변동</dt><dd>${esc(ch.t)}${ch.why&&ch.d?`<span class="sub"><br>${esc(ch.why)}</span>`:''}</dd></div><div><dt>비교 매물</dt><dd>${st.count}건 집계</dd></div>
  <div><dt>목표 총액</dt><dd>${ed.criteria.target==null?'미설정':won(ed.criteria.target)}</dd></div></dl>`;
}
function card(a,m){
  const ed=cardEd(a);
  const h=`<div class="ch"><div><h3>${esc(a.title)}</h3><p class="artist">${esc(a.artist)}</p></div>${a.priority?'<span class="pill">우선 탐색</span>':''}</div>`;
  if(!ed)return`<article class="card">${h}<p class="edl">등록된 판본이 없습니다.</p><button data-act="open" data-id="${a.id}">판본 추가하기</button></article>`;
  const k=ed.criteria.kind,ls_=edListings(ed),js=ls_.map(l=>[l,Engine.judge(l,ed)]);
  const lastAt=ls_.length?Math.max(...ls_.map(Engine.checkedAt)):null;
  const buys=js.filter(([,j])=>j.v==='구매 추천').sort((x,y)=>x[1].tot-y[1].tot),best=buys[0];
  const cnt=Object.keys(V).filter(v=>v!=='제외').map(v=>[v,js.filter(([,j])=>j.v===v).length]).filter(x=>x[1]).map(x=>`${x[0]} ${x[1]}`).join(' · ');
  return`<article class="card">${h}
  <p class="edl"><b>${esc(ed.name)}</b> · ${esc(k)} 기준${activeEds(a).length>1?` <span class="sub">(희망 판본 ${activeEds(a).length}개)</span>`:''}</p>
  ${bestBox(a,ed)}
  ${best?`<div class="rec yes">${vb('구매 추천')} ${esc(best[1].r[0])}</div>`:`<p class="meta">${cnt?esc(cnt):'추적 중인 매물 없음'} · 최근 확인 ${dt(lastAt)}</p>`}
  ${m?`<p class="meta">필터와 일치하는 매물 ${m.length}건</p>`:''}
  <button data-act="open" data-id="${a.id}">매물 비교 보기</button></article>`;
}
function detailView(){
  const a=S.albums.find(x=>x.id===UI.albumId);if(!a){UI.view='list';return listView()}
  const eds=albumEds(a);const ed=eds.find(e=>e.id===UI.editionId)||cardEd(a)||eds[0];
  const top=`<p><button data-act="back">← 목록으로</button></p>
  <h2 style="margin:0">${esc(a.title)}</h2><p class="artist">${esc(a.artist)}${a.priority?' · <b>우선 탐색 중</b>':''}</p>
  <p class="meta">검색어: ${esc((a.queries&&a.queries.length?a.queries:[`${a.artist} ${a.title}`]).join(' / '))} · 다른 표기: ${esc([...(a.titleAliases||[]),...(a.artistAliases||[])].join(', ')||'없음')}</p>
  <div class="acts" style="margin-top:8px"><button data-act="editAlbum">앨범·검색어 수정</button><button data-act="togglePri">${a.priority?'우선 탐색 해제':'우선 탐색 지정'}</button><button data-act="addEd">판본 추가</button><button data-act="direct" data-id="${a.id}">보유 음반 직접 등록</button></div>`;
  if(!ed)return top+`<p class="empty">판본이 없습니다. ‘판본 추가’로 먼저 판본을 등록하세요. 희망 판본이 없으면 스캔하지 않습니다.</p>`;
  UI.editionId=ed.id;
  const tabs=`<div class="eds" role="group" aria-label="판본 선택">${eds.map(e=>`<button data-act="ed" data-id="${e.id}" aria-pressed="${e.id===ed.id}">${esc(e.name)} <span class="sub">· ${e.ended?'탐색 종료':e.wanted?'희망':'희망 아님'}</span></button>`).join('')}</div>`;
  const c=ed.criteria,js=edListings(ed).map(l=>[l,Engine.judge(l,ed)]);
  const act=js.filter(([,j])=>!['제외','판매 확인 필요'].includes(j.v)).sort((x,y)=>V[x[1].v][2]-V[y[1].v][2]||(x[1].tot??Engine.last(x[0]).price??1e12)-(y[1].tot??Engine.last(y[0]).price??1e12));
  const chk=js.filter(([,j])=>j.v==='판매 확인 필요'),out=js.filter(([,j])=>j.v==='제외');
  return top+tabs+`<section class="box" aria-label="판본 정보와 구매 조건"><div class="two">
   <div><b>판본 정보</b><dl class="st" style="margin-top:6px"><div><dt>발매 연도</dt><dd>${ed.year??'미확인'}</dd></div><div><dt>레이블</dt><dd>${esc(ed.label||'미확인')}</dd></div>
    <div><dt>카탈로그 번호</dt><dd>${esc(ed.catalogNo||'미확인')}</dd></div><div><dt>패키지</dt><dd>${esc(ed.packaging)}</dd></div><div><dt>발매 구분</dt><dd>${esc(ed.release)}</dd></div><div><dt>마스터링</dt><dd>${esc(ed.mastering)}</dd></div></dl>
    ${(ed.keywords||[]).length?`<p class="meta">판본 구분 단서: ${esc(ed.keywords.join(', '))}</p>`:''}</div>
   <div><b>구매 조건</b><dl class="st" style="margin-top:6px"><div><dt>희망 구분</dt><dd>${esc(c.kind)}</dd></div><div><dt>목표 총액</dt><dd>${c.target==null?'미설정':won(c.target)}</dd></div>
    ${PARTS.map(([k,n])=>`<div><dt>${n} 허용</dt><dd>${esc(ALLOW.find(x=>x[0]===c[k])[1])}</dd></div>`).join('')}</dl></div></div>
   <div class="acts" style="margin-top:10px"><button data-act="editEd">판본·구매 조건 수정</button><button data-act="toggleWant">${ed.wanted?'희망 판본에서 빼기':'희망 판본으로 지정'}</button><button data-act="toggleEnd">${ed.ended?'이 판본 탐색 재개':'이 판본 탐색 종료'}</button></div></section>
  <div style="margin-top:12px">${bestBox(a,ed)}</div>
  <h2>가격 통계 <small>원본 검증·필수 조건 충족·총액 확인된 판매 중 매물만 · 배송 매물 기준 · 목표가와 무관</small></h2>
  <div class="two">${['중고','신품'].map(k=>`<div class="box"><b>${k}${k===c.kind?' (희망 구분)':''}</b>${statDl(ed,k)}</div>`).join('')}</div>
  <h2>판매 중 매물 비교 <small>${act.length}건</small></h2><div class="acts" style="margin-bottom:10px"><button class="pri" data-act="addL">매물 수동 추가</button></div>
  ${act.length?`<div class="lgrid">${act.map(x=>lcard(...x)).join('')}</div>`:'<p class="empty">판매 중인 매물이 없습니다. 다음 자동 스캔을 기다리거나 직접 추가하세요.</p>'}
  ${chk.length?`<h2>판매 확인 필요 <small>${chk.length}건 · 추천·통계에서 제외</small></h2><div class="lgrid">${chk.map(x=>lcard(...x)).join('')}</div>`:''}
  <h2>제외된 매물 <small>${out.length}건 · 검색·추천·통계에서 제외</small></h2>
  ${out.length?`<details><summary>제외된 매물 ${out.length}건 펼치기</summary><div class="lgrid" style="margin-top:8px">${out.map(x=>lcard(...x)).join('')}</div></details>`:'<p class="empty">제외된 매물이 없습니다.</p>'}`;
}
function lcard(l,j){
  const o=Engine.last(l),reg=S.collection.some(c=>c.listingId===l.id),u=safeUrl(l.url);
  const pr=j.v==='제외'?`<strong>${won(j.lastPrice)}</strong><span>마지막 확인 가격 · 제외 사유: ${esc(j.r[0])}</span>`
    :`<strong>${j.tot==null?(o.price!=null?won(o.price)+'~':'가격 미확인'):won(j.tot)}</strong><span>${l.delivery==='현장'?`현장 구매 · 매장가 ${won(o.price)}`:`배송 수령 · 상품 ${won(o.price)} + 배송비 ${o.shipping==null?'미확인':o.shipping===0?'0원(무료)':won(o.shipping)}`}</span>`;
  return`<article class="lc"><div class="lt"><div class="price">${pr}</div>${vb(j.v)}</div>
  ${l.title?`<p class="ltitle">${esc(l.title)}</p>`:''}
  <ul class="rs">${j.r.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>
  ${(l.hints||[]).length?`<p class="meta">제목에서 찾은 단서: ${esc(l.hints.join(', '))}</p>`:''}
  <p class="meta">디스크 ${esc(o.disc)} · 케이스 ${esc(o.case)} · 북클릿 ${esc(o.booklet)} · 판본 ${esc(o.match)} · 정품 ${esc(o.auth)}${o.authNote?` (${esc(o.authNote)})`:''}</p>
  <p class="meta">${esc(l.source)} · ${esc(l.shop)} · ${esc(l.region)} · ${esc(l.kind)} · ${l.delivery==='현장'?'매장 수령':'배송'} · ${l.auto?'자동 수집':'수동 입력'} · 판매 상태 ${esc(o.status)}</p>
  <p class="meta">${l.auto?(l.verify&&l.verify.okAt?`원본 검증 ${dt(l.verify.okAt)}${l.verify.at!==l.verify.okAt?` · 최근 재확인 실패 ${dt(l.verify.at)}`:''}`:'원본 검증 전 (검색 결과만 확인)'):`직접 입력 ${dt(o.at)}`}</p>
  ${l.verify&&(l.verify.evidence||[]).length?`<details><summary>검증 근거</summary><ul class="rs">${l.verify.evidence.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`:''}
  <details><summary>가격·상태 이력 ${l.obs.length}건</summary><ol class="hist">${[...l.obs].reverse().map(x=>`<li>${dt(x.at)} — ${won(x.price)}${l.delivery==='현장'?' (현장)':` + 배송 ${x.shipping==null?'미확인':won(x.shipping)}`} · ${esc(x.status)} · ${esc(x.via||'')}${x.memo?` · ${esc(x.memo)}`:''}</li>`).join('')}</ol></details>
  <div class="acts">${u?`<a class="btn" href="${esc(u)}" target="_blank" rel="noopener">원문 열기</a>`:''}<button data-act="updL" data-id="${l.id}">매물 갱신 (가격·상태·확인 정보)</button><button data-act="baseL" data-id="${l.id}">기본 정보 수정</button>
  <button data-act="reg" data-id="${l.id}"${reg?' disabled':''}>${reg?'소장 등록됨':'소장 등록'}</button></div></article>`;
}
function ownedView(){
  const rows=S.collection.map(c=>[c,S.albums.find(a=>a.id===c.albumId),S.editions.find(e=>e.id===c.editionId)]).filter(([,a])=>a&&qMatch(a,UI.oq)).sort((x,y)=>String(y[0].date).localeCompare(String(x[0].date)));
  return`<section class="tool"><label class="fld">보유 음반 검색<input id="oq" type="search" value="${esc(UI.oq)}" placeholder="앨범명·아티스트" autocomplete="off"></label>
  <div class="acts"><button class="pri" data-act="direct">보유 음반 직접 등록</button></div></section>
  <h2>보유 음반 <small>${rows.length}장</small></h2>
  ${rows.length?`<div class="grid">${rows.map(([c,a,e])=>`<article class="card"><div class="ch"><div><h3>${esc(a.title)}</h3><p class="artist">${esc(a.artist)}</p></div><span class="pill">소장</span></div>
   <p class="edl"><b>${esc(e?e.name:'판본 미확인')}</b>${e?edChips(e):''}</p>
   <dl class="st"><div><dt>구매가</dt><dd class="big">${won(c.price)}</dd></div><div><dt>구매일</dt><dd>${esc(c.date||'미기재')}</dd></div></dl>
   <p class="meta">구매처: ${esc(c.source||'미기재')}${c.listingId?' · 매물에서 등록':' · 직접 등록'}${c.note?` · ${esc(c.note)}`:''}</p>
   <div class="acts"><button data-act="editC" data-id="${c.id}">구매 기록 수정</button><button data-act="delC" data-id="${c.id}">삭제</button></div></article>`).join('')}</div>`
   :'<p class="empty">아직 보유 음반이 없습니다.</p>'}`;
}

/* ========== 모달 ========== */
function modal(title,body,label,onSubmit,onChange){
  let busy=false;
  $('#modal').innerHTML=`<div class="ov" data-act="ovclose"><form class="sheet" role="dialog" aria-modal="true" aria-labelledby="mt" novalidate><h2 id="mt">${esc(title)}</h2><div class="mb">${body}</div><p class="err" role="alert"></p>
  <div class="mf"><button type="button" data-act="close">취소</button><button type="submit" class="pri">${esc(label)}</button></div></form></div>`;
  const f=$('#modal form');
  f.addEventListener('submit',async e=>{e.preventDefault();if(busy)return;busy=true;const btn=f.querySelector('[type=submit]');btn.disabled=true;
    const d={};f.querySelectorAll('[name]').forEach(el=>{d[el.name]=el.type==='checkbox'?el.checked:el.value});
    let r;try{r=await onSubmit(d)}catch(err){r='오류: '+err.message}
    if(typeof r==='string'){f.querySelector('.err').textContent=r;busy=false;btn.disabled=false}else close()});
  if(onChange)f.addEventListener('change',e=>onChange(e,f));
  const first=f.querySelector('input,select');if(first)first.focus();
}
function close(){$('#modal').innerHTML=''}
const fi=(n,l,v,x='')=>`<label class="fld">${l}<input name="${n}" value="${esc(v??'')}" ${x}></label>`;
const fs=(n,l,arr,v)=>`<label class="fld">${l}<select name="${n}">${opt(arr,v)}</select></label>`;
const fc=(n,l,v)=>`<label class="ck"><input type="checkbox" name="${n}"${v?' checked':''}>${l}</label>`;
function num(v,label,{req}={}){v=String(v??'').replace(/[,\s원]/g,'');if(v==='')return req?{e:`${label}을(를) 입력하세요.`}:{v:null};const n=Number(v);if(!Number.isFinite(n)||n<0)return{e:`${label}은(는) 0 이상의 숫자로 입력하세요.`};return{v:Math.round(n)}}
function toast(t,stay){const el=$('#toast');el.textContent=t;el.classList.add('on');clearTimeout(toast.h);if(!stay)toast.h=setTimeout(()=>el.classList.remove('on'),2800)}
const newEdition=(albumId,id,name)=>({id,albumId,name:name||'CD (판본 미지정)',year:null,label:'',catalogNo:'',packaging:'미확인',release:'미확인',mastering:'미확인',keywords:[],wanted:true,ended:false,criteria:CRIT0()});

function cfgForm(){
  modal('GitHub 연결',`<p class="hint">수정 사항은 저장소의 data/db.json에 커밋됩니다.</p>
   <div class="frow">${fi('owner','계정',cfg.owner)}${fi('repo','저장소',cfg.repo)}</div>
   ${fi('token','Fine-grained 토큰 (Contents: Read and write)',cfg.token,'type="password" autocomplete="off" placeholder="github_pat_…"')}
   ${fc('remember','이 기기에 토큰 기억 (공용 PC에서는 끄기)',cfg.remember)}
   <fieldset><legend>사지방·공용 PC용 암호 잠금 ${lockInfo?'(현재 설정됨)':'(선택)'}</legend>
    <p class="hint">토큰을 암호로 잠가 저장소에 올려 둡니다. 다른 PC에서는 ‘암호로 잠금 해제’에 암호만 입력하면 됩니다. 저장소가 공개라 <b>${MIN_PASS}자 이상</b>, 단어 4개 이상을 이어 붙인 암호를 쓰세요 (예: 파란기타-겨울역-세번째-라디오).</p>
    ${fi('pass','새 암호 (바꾸지 않으려면 비워 두기)','','type="password" autocomplete="new-password"')}${fi('pass2','새 암호 확인','','type="password" autocomplete="new-password"')}
    ${lockInfo?fc('dellock','저장소에서 암호 잠금 삭제',false):''}</fieldset>
   <p class="hint">비워 두고 저장하면 이 기기의 연결이 해제됩니다. 토큰 만드는 곳: GitHub → Settings → Developer settings → Fine-grained tokens (CDfinder만 선택).</p>`,'저장',
   async d=>{
     if(d.pass||d.pass2){if(d.pass!==d.pass2)return'새 암호 두 칸이 서로 다릅니다.';if([...d.pass].length<MIN_PASS)return`암호는 ${MIN_PASS}자 이상이어야 합니다.`;if(!d.token.trim())return'암호 잠금을 만들려면 토큰도 입력해야 합니다.'}
     Object.assign(cfg,{owner:d.owner.trim(),repo:d.repo.trim(),token:d.token.trim(),remember:d.remember});persistCfg();
     if(cfg.token){try{await Remote.load()}catch(e){return'연결 확인 실패: '+e.message}}
     try{
       if(d.pass){toast('암호 잠금 만드는 중…',true);await Remote.putFile('data/lock.json',await makeLock(cfg.token,d.pass),'암호 잠금 설정');lockInfo=true}
       else if(d.dellock){await Remote.delFile('data/lock.json','암호 잠금 삭제');lockInfo=null}
     }catch(e){return'암호 잠금 저장 실패: '+e.message}
     await refresh();checkLock();toast(d.pass?'연결했고 암호 잠금을 저장했습니다.':cfg.token?'GitHub에 연결했습니다.':'읽기 전용으로 전환했습니다.')});
}
function unlockForm(){
  modal('암호로 잠금 해제',`<p class="hint">‘GitHub 연결’에서 만들어 둔 암호를 입력하세요.</p>${fi('pass','암호','','type="password" autocomplete="current-password"')}
   ${fc('remember','이 기기에 기억 (사지방에서는 끄기)',false)}`,'잠금 해제',
   async d=>{toast('확인 중…',true);let lock;try{lock=await Remote.getLock()}catch(e){return'잠금 파일을 불러오지 못했습니다: '+e.message}
     if(!lock)return'저장소에 암호 잠금이 없습니다. ‘GitHub 연결’에서 토큰으로 연결하세요.';
     const t=await openLock(lock,d.pass);if(!t){toast('암호가 맞지 않습니다.');return'암호가 맞지 않습니다.'}
     cfg.token=t;cfg.remember=d.remember;persistCfg();
     try{await Remote.load()}catch(e){cfg.token='';persistCfg();return'잠금은 풀렸지만 토큰이 작동하지 않습니다(만료 가능): '+e.message}
     await refresh();toast('잠금 해제 — 이제 저장할 수 있습니다.')});
}
function albumForm(a){
  const newId=uid('al'),edId=uid('ed');
  modal(a?'앨범·검색어 수정':'탐색할 앨범 추가',fi('title','앨범명 *',a?.title,'required')+fi('artist','아티스트 *',a?.artist,'required')+
   fi('titleAliases','앨범명 다른 표기 (쉼표로 구분)',(a?.titleAliases||[]).join(', '),'placeholder="예: 애비로드, 애비 로드"')+
   fi('artistAliases','아티스트 다른 표기 (쉼표로 구분)',(a?.artistAliases||[]).join(', '),'placeholder="예: 비틀즈, Beatles"')+
   fi('queries','검색어 직접 지정 (쉼표로 구분, 비우면 자동)',(a?.queries||[]).join(', '))+
   '<p class="hint">정확도를 위해 매물 제목에 앨범명(또는 다른 표기)과 아티스트(또는 다른 표기)가 모두 있어야 수집합니다. 한글·영문 표기를 함께 넣어 두세요.</p>'+
   (a?'':fi('edName','판본 (모르면 비워 두기)','','placeholder="예: 2009 리마스터 CD"'))+fc('priority','우선 탐색',a?a.priority:true),
  a?'저장':'추가',d=>{if(!d.title.trim()||!d.artist.trim())return'앨범명과 아티스트를 입력하세요.';
    const v={title:d.title.trim(),artist:d.artist.trim(),titleAliases:list(d.titleAliases),artistAliases:list(d.artistAliases),queries:list(d.queries),priority:d.priority};
    if(!a){UI.view='detail';UI.albumId=newId;UI.editionId=null}
    return save(db=>{if(a){const x=db.albums.find(y=>y.id===a.id);if(!x)return'앨범이 삭제되었습니다.';Object.assign(x,v)}
      else{db.albums.push({id:newId,...v});db.editions.push(newEdition(newId,edId,d.edName.trim()))}},a?'앨범 수정':'앨범 추가')});
}
function edForm(ed,albumId){
  const e=ed||newEdition(albumId,uid('ed'),''),c=e.criteria;
  modal(ed?'판본·구매 조건 수정':'판본 추가',`<fieldset><legend>판본 정보</legend>${fi('name','판본 이름 *',e.name,'required')}<div class="frow">${fi('year','발매 연도',e.year,'inputmode="numeric" placeholder="미확인"')}${fi('label','레이블',e.label,'placeholder="미확인"')}</div>
   ${fi('catalogNo','카탈로그 번호',e.catalogNo,'placeholder="확인한 번호만 입력"')}<div class="frow">${fs('packaging','패키지',PACK,e.packaging)}${fs('release','발매 구분',RELEASE,e.release)}${fs('mastering','마스터링',MASTER,e.mastering)}</div>
   ${fi('keywords','판본 구분 단서 (쉼표로 구분)',(e.keywords||[]).join(', '),'placeholder="예: 일본반, SHM, 2009"')}
   <p class="hint">희망 판본이 여러 개면, 매물 제목에 이 단서가 더 많이 있는 판본에 자동 배정합니다(판본 일치는 여전히 ‘미확인’). 리마스터 여부를 모르는 재발매는 마스터링을 ‘미확인’으로 두세요.</p>${fc('wanted','희망 판본 (자동 스캔 대상)',e.wanted)}</fieldset>
   <fieldset><legend>구매 조건 (매물 가격 이력에는 기록되지 않음)</legend><div class="frow">${fs('kind','희망 구분',['중고','신품'],c.kind)}${fi('target','목표 총액(원)',c.target,'inputmode="numeric" placeholder="미설정"')}</div>
   <div class="frow">${PARTS.map(([k,n])=>fs(k,n+' 허용 상태',ALLOW,c[k]||'ANY')).join('')}</div>${fc('requireAuth','정품 근거 확인을 필수 조건으로',c.requireAuth)}
   <p class="hint">‘상관없음’이 아닌 상태나 정품 근거를 필수로 지정하면, 원문에서 확인되지 않는 매물은 추천을 보류합니다. 판본 구분 단서·카탈로그 번호를 넣으면 원문에서 일치 근거가 있어야 추천합니다.</p></fieldset>`,
  ed?'저장':'추가',d=>{if(!d.name.trim())return'판본 이름을 입력하세요.';const y=num(d.year,'발매 연도'),t=num(d.target,'목표 총액');if(y.e)return y.e;if(t.e)return t.e;
    const v={name:d.name.trim(),year:y.v,label:d.label.trim(),catalogNo:d.catalogNo.trim(),packaging:d.packaging,release:d.release,mastering:d.mastering,keywords:list(d.keywords),wanted:d.wanted,criteria:{kind:d.kind,target:t.v,disc:d.disc,case:d.case,booklet:d.booklet,requireAuth:d.requireAuth,userSet:true}};
    if(!ed)UI.editionId=e.id;
    return save(db=>{if(ed){const x=db.editions.find(z=>z.id===ed.id);if(!x)return'판본이 삭제되었습니다.';Object.assign(x,v)}else db.editions.push({...e,...v})},ed?'판본·조건 수정':'판본 추가')});
}
const obsFields=o=>`<fieldset><legend>가격·판매 상태</legend><div class="frow">${fi('price','상품가/매장가(원)',o.price,'inputmode="numeric" placeholder="미확인"')}${fi('shipping','배송비(원)',o.shipping,'inputmode="numeric" placeholder="미확인"')}${fs('status','판매 상태',STATUS,o.status)}</div>
 <p class="hint">배송비를 비워 두면 ‘배송비 미확인’, 무료 배송은 0. 현장 구매는 배송비를 쓰지 않습니다.</p></fieldset>
 <fieldset><legend>확인 정보</legend><div class="frow">${fs('auth','정품 여부',AUTH,o.auth)}${fs('match','판본 일치',MATCH,o.match)}</div>${fi('authNote','정품 근거 메모',o.authNote,'placeholder="예: 실물 사진으로 링 각인 확인"')}
 <p class="hint">판매자의 ‘정품’ 기재나 판본 정보 일치만으로는 ‘확인됨’으로 두지 마세요.</p>
 <div class="frow">${fs('disc','디스크',GRADES,o.disc)}${fs('case','케이스',GRADES,o.case)}${fs('booklet','북클릿',BGRADES,o.booklet)}</div>${fi('memo','관측 메모',o.memo||'','placeholder="선택"')}</fieldset>`;
function readObs(d){const p=num(d.price,'가격'),s=num(d.shipping,'배송비');if(p.e)return p.e;if(s.e)return s.e;
  return{price:p.v,shipping:s.v,status:d.status,auth:d.auth,match:d.match,authNote:d.authNote.trim(),disc:d.disc,case:d.case,booklet:d.booklet,memo:d.memo.trim()}}
function pushObs(l,o){const prev=l.obs[l.obs.length-1],at=Math.max(Date.now(),prev?prev.at+1:0);l.obs.push({...o,at,via:'수동',ver:true});l.checkedAt=at;
  if(l.auto)l.verify={at,ok:true,okAt:at,error:null,evidence:['사용자가 원본을 보고 직접 확인']}}
const baseFields=(l,a)=>`<fieldset><legend>매물 기본 정보</legend>${fs('editionId','판본',albumEds(a).map(e=>[e.id,e.name]),l.editionId)}<div class="frow">${fs('source','출처',SOURCES,l.source)}${fs('kind','신품/중고',['중고','신품'],l.kind)}${fs('delivery','수령 방식',[['배송','배송 수령'],['현장','현장 구매']],l.delivery)}</div>
 <div class="frow">${fi('shop','매장명/판매자',l.shop)}${fi('region','지역',l.region)}</div>${fi('url','매물 링크',l.url||'','type="url" placeholder="https://"')}</fieldset>`;
const readBase=d=>d.shop.trim()&&d.region.trim()?{editionId:d.editionId,source:d.source,kind:d.kind,delivery:d.delivery,shop:d.shop.trim(),region:d.region.trim(),url:safeUrl(d.url.trim())||''}:'매장명/판매자와 지역을 입력하세요.';
function addListing(a,ed){
  const id=uid('ls');
  modal('매물 수동 추가',baseFields({editionId:ed.id,source:'번개장터',kind:ed.criteria.kind,delivery:'배송',shop:'',region:''},a)+obsFields({price:null,shipping:null,status:'판매중',auth:'미확인',match:'미확인',authNote:'',disc:'미확인',case:'미확인',booklet:'미확인'}),'추가',
   d=>{const b=readBase(d);if(typeof b==='string')return b;const o=readObs(d);if(typeof o==='string')return o;UI.editionId=b.editionId;
     return save(db=>{if(db.listings.some(x=>x.id===id))return;const l={id,...b,auto:false,firstSeen:Date.now(),obs:[]};pushObs(l,o);db.listings.push(l)},'매물 추가')});
}
function updListing(l){
  const o=Engine.last(l);
  modal('매물 갱신 — 다시 확인한 내용 기록',`<p class="hint">저장하면 같은 매물 ID에 새 관측 기록이 추가되고 이전 가격·상태는 이력에 남습니다.</p>${safeUrl(l.url)?`<p><a href="${esc(l.url)}" target="_blank" rel="noopener">원문 열기</a></p>`:''}`+obsFields({...o,memo:''}),'관측 기록 저장',
   d=>{const n=readObs(d);if(typeof n==='string')return n;return save(db=>{const x=db.listings.find(y=>y.id===l.id);if(!x)return'매물이 없습니다.';pushObs(x,n)},'매물 갱신')});
}
function baseListing(l){const ed=S.editions.find(e=>e.id===l.editionId),a=S.albums.find(x=>x.id===ed.albumId);
  modal('매물 기본 정보 수정',baseFields(l,a)+'<p class="hint">기본 정보 수정은 가격 이력에 기록하지 않습니다.</p>','저장',d=>{const b=readBase(d);if(typeof b==='string')return b;
    return save(db=>{const x=db.listings.find(y=>y.id===l.id);if(!x)return'매물이 없습니다.';Object.assign(x,b)},'매물 기본 정보 수정')})}
function regFromListing(l){
  if(S.collection.some(c=>c.listingId===l.id)){toast('이미 소장 등록한 매물입니다.');return}
  const ed=S.editions.find(e=>e.id===l.editionId),a=S.albums.find(x=>x.id===ed.albumId),o=Engine.last(l),lp=Engine.lastPriced(l);
  const token=uid('tk'),tot=Engine.total(l,o)??(lp?Engine.total(l,lp)??lp.price:null);
  modal('소장 등록',`<p><b>${esc(a.title)}</b> — ${esc(a.artist)}</p>${fs('editionId','판본',albumEds(a).map(e=>[e.id,e.name]),ed.id)}${fi('source','구매처',`${l.source} · ${l.shop} (${l.delivery==='현장'?'현장 구매':'배송'})`)}
   <div class="frow">${fi('price','실제 구매가(원)',tot,'inputmode="numeric"')}${fi('date','구매일',today(),'type="date"')}</div>${fi('note','메모','','placeholder="선택"')}
   ${fc('end','이 판본 탐색 종료 (같은 앨범의 다른 희망 판본은 유지)',true)}`,'소장 등록',
   d=>{const p=num(d.price,'구매가',{req:true});if(p.e)return p.e;
     return save(db=>{if(db.collection.some(c=>c.listingId===l.id||c.token===token))return'이미 등록되어 중복 등록하지 않았습니다.';
       db.collection.push({id:uid('own'),token,albumId:a.id,editionId:d.editionId,listingId:l.id,source:d.source.trim(),price:p.v,date:d.date,note:d.note.trim(),createdAt:Date.now()});
       if(d.end){const e=db.editions.find(x=>x.id===d.editionId);if(e)e.ended=true}},'소장 등록')});
}
function direct(albumId){
  const token=uid('tk'),aOpts=[...S.albums.map(a=>[a.id,`${a.title} — ${a.artist}`]),['__new','+ 새 앨범 입력']];
  const sel=albumId||S.albums[0]?.id||'__new',newA=uid('al'),newE=uid('ed');
  const edOpts=aid=>[...S.editions.filter(e=>e.albumId===aid).map(e=>[e.id,e.name]),['__new','+ 새 판본 (정보 미확인)']];
  modal('보유 음반 직접 등록',`${fs('albumId','앨범',aOpts,sel)}<div id="newA" class="frow"${sel==='__new'?'':' hidden'}>${fi('nTitle','새 앨범명','')}${fi('nArtist','새 아티스트','')}</div>
   <label class="fld">판본<select name="editionId" id="edSel">${opt(edOpts(sel),'')}</select></label>${fi('nEd','새 판본 이름 (새 판본 선택 시)','CD')}
   <div class="frow">${fi('price','구매가(원)','','inputmode="numeric" placeholder="미기재"')}${fi('date','구매일',today(),'type="date"')}</div>${fi('source','구매처','')}${fi('note','메모','')}
   ${fc('end','이 판본 탐색 종료',true)}`,'등록',
   d=>{const p=num(d.price,'구매가');if(p.e)return p.e;if(d.albumId==='__new'&&(!d.nTitle.trim()||!d.nArtist.trim()))return'새 앨범명과 아티스트를 입력하세요.';
     return save(db=>{if(db.collection.some(c=>c.token===token))return;
       let aid=d.albumId;if(aid==='__new'){aid=newA;db.albums.push({id:aid,title:d.nTitle.trim(),artist:d.nArtist.trim(),titleAliases:[],artistAliases:[],queries:[],priority:false})}
       let eid=d.editionId;if(!eid||eid==='__new'){eid=newE;db.editions.push({...newEdition(aid,eid,d.nEd.trim()||'CD'),wanted:false})}
       if(d.end){const e=db.editions.find(x=>x.id===eid);if(e)e.ended=true}
       db.collection.push({id:uid('own'),token,albumId:aid,editionId:eid,listingId:null,source:d.source.trim(),price:p.v,date:d.date,note:d.note.trim(),createdAt:Date.now()})},'보유 음반 등록')},
   (e,f)=>{if(e.target.name==='albumId'){const v=e.target.value;f.querySelector('#newA').hidden=v!=='__new';f.querySelector('#edSel').innerHTML=opt(edOpts(v),'')}});
}
function editC(c){modal('구매 기록 수정',`<div class="frow">${fi('price','구매가(원)',c.price,'inputmode="numeric"')}${fi('date','구매일',c.date,'type="date"')}</div>${fi('source','구매처',c.source)}${fi('note','메모',c.note)}`,'저장',
  d=>{const p=num(d.price,'구매가');if(p.e)return p.e;return save(db=>{const x=db.collection.find(y=>y.id===c.id);if(!x)return'기록이 없습니다.';Object.assign(x,{price:p.v,date:d.date,source:d.source.trim(),note:d.note.trim()})},'구매 기록 수정')})}

/* ========== 이벤트 ========== */
const armed={};
function arm(btn,key,text,fn){if(armed[key]){delete armed[key];fn();return}armed[key]=1;btn.textContent=text;setTimeout(()=>{delete armed[key]},5000)}
async function quick(fn,msg){const r=await save(fn,msg);if(typeof r==='string')toast(r)}
document.addEventListener('click',e=>{
  const b=e.target.closest('[data-act]');if(!b)return;const act=b.dataset.act,id=b.dataset.id;
  if(act==='ovclose'&&e.target!==b)return;
  if(!S&&!['cfg','unlock','refresh','close','ovclose','tab'].includes(act))return;
  const a=S&&S.albums.find(x=>x.id===UI.albumId),ed=S&&S.editions.find(x=>x.id===UI.editionId),l=S&&S.listings.find(x=>x.id===id);
  switch(act){
    case'tab':UI.tab=b.dataset.v;render();scrollTo(0,0);break;
    case'open':UI.view='detail';UI.albumId=id;UI.editionId=null;render();scrollTo(0,0);break;
    case'back':UI.view='list';render();break;
    case'ed':UI.editionId=id;render();break;
    case'clearf':UI.q='';UI.f={source:'',region:'',kind:'',verdict:''};render();break;
    case'refresh':toast('불러오는 중…',true);refresh().then(()=>toast('최신 데이터를 불러왔습니다.'));break;
    case'cfg':cfgForm();break;case'unlock':unlockForm();break;
    case'addAlbum':albumForm();break;case'editAlbum':albumForm(a);break;
    case'togglePri':quick(db=>{const x=db.albums.find(y=>y.id===a.id);x.priority=!x.priority},a.priority?'우선 탐색 해제':'우선 탐색 지정');break;
    case'addEd':edForm(null,a.id);break;case'editEd':edForm(ed);break;
    case'toggleWant':quick(db=>{const x=db.editions.find(y=>y.id===ed.id);x.wanted=!x.wanted},ed.wanted?'희망 판본 해제':'희망 판본 지정');break;
    case'toggleEnd':quick(db=>{const x=db.editions.find(y=>y.id===ed.id);x.ended=!x.ended},ed.ended?'탐색 재개':'탐색 종료');break;
    case'addL':addListing(a,ed);break;case'updL':updListing(l);break;case'baseL':baseListing(l);break;case'reg':regFromListing(l);break;
    case'direct':direct(id);break;
    case'editC':editC(S.collection.find(c=>c.id===id));break;
    case'delC':arm(b,'del'+id,'한 번 더 누르면 삭제',()=>quick(db=>{db.collection=db.collection.filter(c=>c.id!==id)},'구매 기록 삭제'));break;
    case'close':case'ovclose':close();break;
  }
});
document.addEventListener('input',e=>{
  if(e.target.id==='q'){UI.q=e.target.value;$('#results').innerHTML=results()}
  if(e.target.id==='oq'){UI.oq=e.target.value;const p=e.target.selectionStart;render();const n=$('#oq');n.focus();n.setSelectionRange(p,p)}});
document.addEventListener('change',e=>{if(e.target.dataset.f){UI.f[e.target.dataset.f]=e.target.value;$('#results').innerHTML=results()}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('#modal').innerHTML)close()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(true)});
setInterval(()=>{if(!document.hidden)refresh(true)},120000);
render();refresh();checkLock();
window.__cd={get S(){return S},cfg,Engine};
}
