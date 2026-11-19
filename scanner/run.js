/* cdfinder 수집기 — GitHub Actions에서 실행.
   node scanner/run.js fetch   : 사이트에서 매물 읽기 → tmp/results.json (data는 건드리지 않음)
   node scanner/run.js merge   : 최신 data/db.json에 결과 병합·알림 대상 계산 → tmp/alerts.json
   node scanner/run.js notify  : 텔레그램으로 알림 발송
   fetch와 merge를 나눈 이유: 웹앱에서 사용자가 동시에 저장해도, 최신 db 위에 다시 병합하면 충돌이 없다. */
'use strict';
const fs = require('fs');
const path = require('path');
const Engine = require('../engine.js');
const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data/db.json');
const TMP = path.join(ROOT, 'tmp');
const REPORT = path.join(ROOT, 'data/scan-report.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJSON = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1) + '\n'); };

/* ---------- 매칭 ---------- */
const norm = s => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
const NOT_CD = /(lp|엘피|바이닐|vinyl|카세트|cassette|테이프|tape|블루레이|blu-?ray|dvd)/i;
const IS_CD = /(cd|씨디|시디)/i;
const MERCH = /(퍼즐|티셔츠|반팔|긴팔|후드|맨투맨|포스터|액자|스티커|키링|머그|에코백|엽서|토트백|양말|모자|피규어|그립톡|폰케이스|핸드폰\s*케이스|악보|책\b|도서|매거진|잡지)/i;
const WANTED_POST = /(삽니다|구매합니다|구매해요|구합니다|구해요|구해봅니다|매입|사요\b|찾습니다)/;
const BUNDLE = /(일괄|세트로|묶음|통째)/;
function relevant(name, a) {
  const n = norm(name);
  const titleHit = [a.title, ...(a.titleAliases || [])].some(t => norm(t) && n.includes(norm(t)));
  const artistHit = [a.artist, ...(a.artistAliases || [])].some(t => norm(t) && n.includes(norm(t)));
  if (!titleHit || !artistHit) return false;            // 정확도 우선: 앨범명과 아티스트가 모두 있어야 함
  if (NOT_CD.test(name) && !IS_CD.test(name)) return false;
  if (MERCH.test(name) || WANTED_POST.test(name)) return false;   // 굿즈·구매 희망 글 제외
  return true;
}
function queries(a) {
  if (a.queries && a.queries.length) return a.queries.slice(0, 3);
  const q = [`${a.artist} ${a.title}`];
  if ((a.artistAliases || [])[0] && (a.titleAliases || [])[0]) q.push(`${a.artistAliases[0]} ${a.titleAliases[0]}`);
  return q;
}
function pickEdition(db, a, name) {
  const act = db.editions.filter(e => e.albumId === a.id && e.wanted && !e.ended);
  if (!act.length) return null;
  if (act.length === 1) return act[0];
  const n = norm(name); let best = act[0], bs = -1;
  for (const e of act) {
    const keys = [...String(e.name).split(/\s+/), e.catalogNo, e.year, e.label, ...(e.keywords || [])].filter(Boolean).map(norm).filter(k => k.length >= 2 && k !== 'cd');
    const s = keys.filter(k => n.includes(k)).length;
    if (s > bs) { bs = s; best = e; }
  }
  return best;
}
function hints(text) {
  const h = [], t = String(text || '');
  if (/미개봉|sealed|새상품|새 상품/i.test(t)) h.push('미개봉 표기');
  if (/(북클릿|가사집|속지)\s*(없|x|누락|분실)/i.test(t)) h.push('북클릿 누락 표기');
  if (/스크래치|기스|흠집/i.test(t)) h.push('스크래치 언급');
  if (/(케이스)\s*(깨|파손|금)/i.test(t)) h.push('케이스 파손 언급');
  if (/싸인|사인반|sign/i.test(t)) h.push('사인반 표기');
  if (/일본|japan|일본반|jp/i.test(t)) h.push('일본반 표기');
  if (/리마스터|remaster/i.test(t)) h.push('리마스터 표기');
  if (/해적|부트|bootleg|복제/i.test(t)) h.push('비정규반 의심 표현');
  return h;
}

/* ---------- 네트워크 ---------- */
async function get(url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9', ...headers }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
  return r;
}

/* ---------- 출처 어댑터 ----------
   search(q) → [{sid, title, price, shipping, status, region, shop, url, kind, raw}]
   check(listing) → {price?, status} | null   (추적 중인 매물 재확인) */
const BUNJANG_STATUS = { '0': '판매중', '1': '미확인', '2': '판매완료', '3': '판매완료' }; // 1=예약중으로 추정 → 판매 확인 필요
const sources = {
  bunjang: {
    label: '번개장터', enabled: () => process.env.BUNJANG !== 'off',
    async search(q) {
      const url = `https://api.bunjang.co.kr/api/1/find_v2.json?q=${encodeURIComponent(q)}&order=date&page=0&n=60&stat_device=w&version=4`;
      const r = await get(url, { accept: 'application/json' });
      if (r.status === 404 || r.status === 403) throw new Error(`HTTP ${r.status} — 해외 서버 IP 차단으로 보임(국내 IP 필요)`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const list = Array.isArray(j.list) ? j.list : [];
      return list.filter(x => x && x.pid && !x.ad && !x.bizseller_ad).map(x => ({
        sid: String(x.pid), title: String(x.name || ''), price: Number(x.price) > 0 ? Number(x.price) : null,
        shipping: x.free_shipping === true || x.free_shipping === 1 ? 0 : null,
        status: BUNJANG_STATUS[String(x.status)] || '미확인',
        region: x.location ? String(x.location) : '판매자 지역 미기재', shop: '번개장터 판매자',
        url: `https://m.bunjang.co.kr/products/${x.pid}`, kind: '중고',
        raw: { status: x.status, free_shipping: x.free_shipping, keys: Object.keys(x).slice(0, 40) }
      }));
    },
    async check(l) {
      const r = await get(l.url, { accept: 'text/html' });
      if (r.status === 404 || r.status === 410) return { status: '미확인', note: '페이지 없음' };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const html = await r.text();
      const meta = k => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["'](?:meta-)?product:${k}["'][^>]*content=["']([^"']*)`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["'](?:meta-)?product:${k}["']`, 'i')); return m ? m[1] : null; };
      const av = (meta('availability') || '').toLowerCase().replace(/\s/g, '');
      const price = Number(meta('price:amount')) || null;
      const status = av === 'oos' || av === 'outofstock' ? '판매완료' : av === 'instock' ? '판매중' : '미확인';
      return { status, price, note: av ? `availability=${av}` : 'availability 정보 없음' };
    }
  },
  aladin: {
    label: '알라딘', enabled: () => !!process.env.ALADIN_TTB_KEY,
    async search(q) {
      const key = process.env.ALADIN_TTB_KEY, base = 'http://www.aladin.co.kr/ttb/api/';
      const parse = async r => { if (!r.ok) throw new Error('HTTP ' + r.status); const t = (await r.text()).trim().replace(/;$/, ''); return JSON.parse(t); };
      const s = await parse(await get(`${base}ItemSearch.aspx?ttbkey=${key}&Query=${encodeURIComponent(q)}&QueryType=Keyword&SearchTarget=Music&MaxResults=20&start=1&output=js&Version=20131101`));
      if (s.errorCode) throw new Error(`API 오류 ${s.errorCode} ${s.errorMessage || ''}`);
      const out = [];
      for (const it of (s.item || []).slice(0, 6)) {
        out.push({ sid: `${it.itemId}:new`, title: it.title, price: it.priceSales || null, shipping: null, status: it.stockStatus ? (/품절|절판/.test(it.stockStatus) ? '품절' : '미확인') : '판매중', region: '온라인', shop: '알라딘 신품', url: it.link, kind: '신품', raw: { stockStatus: it.stockStatus } });
        await sleep(400);
        try {
          const d = await parse(await get(`${base}ItemLookUp.aspx?ttbkey=${key}&itemIdType=ItemId&ItemId=${it.itemId}&output=js&Version=20131101&OptResult=usedList`));
          const ul = d.item && d.item[0] && d.item[0].subInfo && d.item[0].subInfo.usedList;
          for (const [k, lab] of [['aladinUsed', '알라딘 직접 중고'], ['userUsed', '알라딘 회원 중고'], ['spaceUsed', '알라딘 중고매장']]) {
            const u = ul && ul[k]; if (!u) continue;
            out.push({ sid: `${it.itemId}:${k}`, title: it.title, price: u.itemCount > 0 ? (u.minPrice || null) : null, shipping: null, status: u.itemCount > 0 ? '판매중' : '품절', region: '온라인', shop: `${lab} 최저가 (${u.itemCount || 0}건)`, url: u.link || it.link, kind: '중고', raw: { k, itemCount: u.itemCount } });
          }
        } catch (e) { /* 중고 정보 없음 */ }
      }
      return out;
    }
  }
};
/* 중고나라: 검색 페이지에 서버 렌더링된 상품 목록(JSON)이 들어 있다. 기본 검색은 판매완료 제외. */
const unq = x => { let v; try { v = JSON.parse('"' + x + '"'); } catch { v = x; } return String(v).replace(/\\+u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); };
sources.joongna = {
  label: '중고나라', enabled: () => true,
  async search(q) {
    const r = await get(`https://web.joongna.com/search/${encodeURIComponent(q)}`, { accept: 'text/html' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const s = (await r.text()).replace(/\\"/g, '"');
    const i = s.indexOf('"items":[{"seq":'); if (i < 0) return [];
    const chunks = s.slice(i).split('{"seq":').slice(1, 61);
    const out = [];
    for (const c of chunks) {
      const f = k => { const m = c.match(new RegExp(`"${k}":("(?:[^"\\\\]|\\\\.)*"|-?\\d+|null|true|false)`)); return m ? (m[1][0] === '"' ? unq(m[1].slice(1, -1)) : m[1]) : null; };
      const seq = (c.match(/^(\d+)/) || [])[1]; const title = f('title'); if (!seq || !title) continue;
      const st = String(f('state'));
      out.push({ sid: seq, title, price: Number(f('price')) || null, shipping: null,
        status: st === '0' ? '판매중' : (st === '2' || st === '3') ? '판매완료' : '미확인',
        region: f('mainLocationName') || '판매자 지역 미기재', shop: '중고나라 판매자', url: `https://web.joongna.com/product/${seq}`, kind: '중고',
        raw: { state: st, parcelFee: f('parcelFee'), sortDate: f('sortDate') } });
    }
    return out;
  }
};
/* 헬로마켓: __NEXT_DATA__ 안의 상품 객체(idx·title·price·sellState) */
const HM_STATE = { ForSale: '판매중', Reserved: '미확인', Reservation: '미확인', SoldOut: '판매완료', Sold: '판매완료', Complete: '판매완료' };
sources.hellomarket = {
  label: '헬로마켓', enabled: () => true,
  async search(q) {
    const r = await get(`https://www.hellomarket.com/search?q=${encodeURIComponent(q)}`, { accept: 'text/html' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = (await r.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/); if (!m) return [];
    const found = new Map();
    (function walk(o) { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk);
      const id = o.idx ?? o.itemIdx ?? o.itemId; if (id && typeof o.title === 'string' && o.price !== undefined) found.set(String(id), o); else for (const k in o) walk(o[k]); })(JSON.parse(m[1]));
    return [...found.values()].slice(0, 60).map(o => ({ sid: String(o.idx ?? o.itemIdx ?? o.itemId), title: String(o.title), price: Number(o.price) || null, shipping: null,
      status: HM_STATE[o.sellState && o.sellState.code] || '미확인', region: (o.location && (o.location.name || o.location.fullName)) || '판매자 지역 미기재', shop: '헬로마켓 판매자',
      url: `https://www.hellomarket.com/item/${o.idx ?? o.itemIdx ?? o.itemId}`, kind: '중고', raw: { sellState: o.sellState && o.sellState.code, keys: Object.keys(o).slice(0, 30) } }));
  }
};
const probes = [];

/* ---------- fetch ---------- */
async function doFetch() {
  const db = readJSON(DB);
  const albums = db.albums.filter(a => db.editions.some(e => e.albumId === a.id && e.wanted && !e.ended));
  const res = { at: Date.now(), found: [], checks: [], sources: {}, searched: [] };
  const seen = new Set();
  for (const [key, src] of Object.entries(sources)) {
    const st = res.sources[key] = { label: src.label, ok: 0, fail: 0, items: 0, matched: 0, errors: [], sample: null };
    if (!src.enabled()) { st.skipped = '설정 없음 (비밀 키 미등록)'; continue; }
    for (const a of albums) { let allOk = true; for (const q of queries(a)) {
      try {
        const items = await src.search(q); st.ok++; st.items += items.length;
        if (!st.sample && items[0]) st.sample = items[0];
        for (const it of items) {
          if (!relevant(it.title, a)) continue;
          const id = `${key}:${it.sid}`; if (seen.has(id)) continue; seen.add(id);
          st.matched++; res.found.push({ source: key, albumId: a.id, id, it });
        }
      } catch (e) { allOk = false; st.fail++; if (st.errors.length < 5) st.errors.push(`${q}: ${e.message}`); }
      await sleep(1200);
    } if (allOk) res.searched.push(`${key}|${a.id}`); }
  }
  /* 추적 중인 매물 재확인: 이번 검색에 안 잡힌 판매 중/확인 필요 매물, 오래된 순 최대 20건 */
  const tracked = db.listings.filter(l => l.auto && !seen.has(l.id) && sources[l.sourceKey] && sources[l.sourceKey].check && !Engine.OUT.includes(Engine.last(l).status))
    .sort((x, y) => Engine.checkedAt(x) - Engine.checkedAt(y)).slice(0, 20);
  for (const l of tracked) {
    try { const c = await sources[l.sourceKey].check(l); if (c) res.checks.push({ id: l.id, ...c }); }
    catch (e) { res.checks.push({ id: l.id, error: e.message }); }
    await sleep(1200);
  }
  res.probes = [];
  for (const [name, mk] of probes) {
    try { const r = await get(mk('beatles abbey road')); const t = await r.text(); res.probes.push({ name, status: r.status, bytes: t.length, hasKeyword: /abbey/i.test(t) }); }
    catch (e) { res.probes.push({ name, error: e.message }); }
  }
  writeJSON(path.join(TMP, 'results.json'), res);
  console.log(JSON.stringify({ sources: res.sources, found: res.found.length, checks: res.checks.length, probes: res.probes }, null, 1));
}

/* ---------- merge ---------- */
function pushObs(l, v, at) {
  const prev = Engine.last(l) || { auth: '미확인', authNote: '', match: '미확인', disc: '미확인', case: '미확인', booklet: '미확인' };
  l.obs.push(Object.assign({}, prev, { memo: '' }, v, { at: Math.max(at, prev.at ? prev.at + 1 : 0), via: '자동' }));
}
function doMerge() {
  const db = readJSON(DB), res = readJSON(path.join(TMP, 'results.json'));
  if (!res) { console.log('결과 없음'); return; }
  db.meta = db.meta || {}; db.alerts = db.alerts || [];
  const at = res.at, touched = new Set();
  const cleanPrice = p => (p == null || p <= 1000 || /^9{5,}$/.test(String(p))) ? null : p;   // 0원·1000원(가격 제시)·999999 같은 자리값 제외
  /* 규칙이 바뀌어 더 이상 관련 없는 자동 수집 매물은 정리 (소장 기록에 쓰인 것은 유지) */
  db.listings = db.listings.filter(l => { if (!l.auto || db.collection.some(c => c.listingId === l.id)) return true;
    const ed = db.editions.find(e => e.id === l.editionId), a = ed && db.albums.find(x => x.id === ed.albumId);
    return a && relevant(l.title || '', a); });
  for (const f of res.found) {
    const a = db.albums.find(x => x.id === f.albumId); if (!a) continue;
    const it = f.it; let l = db.listings.find(x => x.id === f.id);
    if (!l) {
      const ed = pickEdition(db, a, it.title); if (!ed) continue;
      it.price = cleanPrice(it.price);
      l = { id: f.id, sourceKey: f.source, bundle: BUNDLE.test(it.title) || undefined, editionId: ed.id, source: sources[f.source].label, shop: it.shop, region: it.region, delivery: '배송', kind: it.kind || '중고', url: it.url, title: it.title, hints: [...hints(it.title), ...(BUNDLE.test(it.title) ? ['일괄 판매 — 시세·알림에서 제외'] : []), ...(cleanPrice(it.price) == null ? ['가격 미기재 또는 자리값'] : [])], auto: true, firstSeen: at, checkedAt: at, obs: [] };
      db.listings.push(l);
      pushObs(l, { price: it.price, shipping: it.shipping, status: it.status, auth: '미확인', match: '미확인', disc: '미확인', case: '미확인', booklet: '미확인', authNote: '' }, at);
    } else {
      l.checkedAt = at; l.title = it.title; if (it.shop) l.shop = it.shop; l.bundle = BUNDLE.test(it.title) || undefined;
      const o = Engine.last(l);
      if (o.status === '숨김') { touched.add(l.id); continue; }       // 사용자가 숨긴 매물은 건드리지 않음
      const v = { price: cleanPrice(it.price), shipping: it.shipping ?? o.shipping, status: it.status };
      if (v.price !== o.price || v.shipping !== o.shipping || v.status !== o.status) pushObs(l, v, at);
    }
    touched.add(l.id);
  }
  for (const c of res.checks) {
    const l = db.listings.find(x => x.id === c.id); if (!l || c.error) continue;
    const o = Engine.last(l); if (o.status === '숨김') continue;
    l.checkedAt = at;
    const v = { price: c.price ?? o.price, shipping: o.shipping, status: c.status };
    if (v.price !== o.price || v.status !== o.status) pushObs(l, v, at);
    touched.add(l.id);
  }
  /* 검색이 정상이었는데 2회 연속 결과에서 사라진 매물 → 판매 확인 필요 (판매완료로 단정하지 않음) */
  const searched = new Set(res.searched || []);
  for (const l of db.listings) {
    if (!l.auto || touched.has(l.id)) continue;
    const ed = db.editions.find(e => e.id === l.editionId); if (!ed || !searched.has(`${l.sourceKey}|${ed.albumId}`)) continue;
    const o = Engine.last(l); if (o.status !== '판매중') continue;
    l.missCount = (l.missCount || 0) + 1; l.checkedAt = at;
    if (l.missCount >= 2) pushObs(l, { status: '미확인', memo: '검색 결과에서 사라짐 (2회 연속) — 판매완료 가능성' }, at);
  }
  for (const id of touched) { const l = db.listings.find(x => x.id === id); if (l) l.missCount = 0; }
  /* 알림 대상 */
  const alerts = [], sent = new Set(db.alerts.map(x => x.key));
  for (const id of touched) {
    const l = db.listings.find(x => x.id === id), ed = db.editions.find(e => e.id === l.editionId);
    if (!ed || !ed.wanted || ed.ended) continue;
    const c = Engine.cheap(db, l, ed); if (!c) continue;
    const key = `${l.id}@${c.value}`; if (sent.has(key)) continue;
    const a = db.albums.find(x => x.id === ed.albumId);
    const al = { key, at, listingId: l.id, album: `${a.artist} — ${a.title}`, edition: ed.name, value: c.value, shippingKnown: c.shippingKnown, why: c.why, source: l.source, title: l.title, url: l.url };
    alerts.push(al); db.alerts.push(al);
  }
  db.alerts = db.alerts.slice(-300);
  db.meta.lastScan = at;
  db.meta.sources = Object.fromEntries(Object.entries(res.sources).map(([k, s]) => [k, { label: s.label, ok: s.ok, fail: s.fail, items: s.items, matched: s.matched, skipped: s.skipped || null, error: s.errors[0] || null }]));
  db.meta.probes = res.probes;
  writeJSON(DB, db);
  writeJSON(REPORT, { at, sources: res.sources, probes: res.probes, checks: res.checks.slice(0, 20) });
  writeJSON(path.join(TMP, 'alerts.json'), alerts);
  console.log(`병합: 매물 ${touched.size}건 갱신, 알림 ${alerts.length}건`);
}

/* ---------- notify ---------- */
async function doNotify() {
  const alerts = readJSON(path.join(TMP, 'alerts.json'), []);
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!alerts.length) return console.log('보낼 알림 없음');
  if (!tok || !chat) return console.log(`텔레그램 미설정 — 알림 ${alerts.length}건은 웹앱 ‘싼 매물 알림’에만 표시`);
  const fmt = n => n.toLocaleString('ko-KR');
  const lines = alerts.slice(0, 10).map(a => `💿 ${a.album} (${a.edition})\n${a.source} · ${fmt(a.value)}원${a.shippingKnown ? ' (배송 포함)' : ' + 배송비 미확인'}\n${a.why.join(', ')}\n${a.title}\n${a.url}`);
  if (alerts.length > 10) lines.push(`…외 ${alerts.length - 10}건은 웹앱에서 확인`);
  for (const text of lines) {
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: false }) });
    if (!r.ok) console.log('텔레그램 발송 실패', r.status, await r.text());
    await sleep(500);
  }
  console.log(`알림 ${Math.min(alerts.length, 10)}건 발송`);
}

if (require.main === module) {
  const mode = process.argv[2];
  ({ fetch: doFetch, merge: doMerge, notify: doNotify }[mode] || (() => { console.log('usage: fetch|merge|notify'); process.exit(1); }))();
}
module.exports = { relevant, pickEdition, hints, norm, sources };
