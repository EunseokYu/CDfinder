/* cdfinder 수집기 — GitHub Actions에서 실행.
   node scanner/run.js fetch   : 발견(검색) → 개별 원본 검증 → tmp/results.json (data는 건드리지 않음)
   node scanner/run.js merge   : 최신 data/db.json에 결과 병합·알림 대상 계산 → tmp/alerts.json
   node scanner/run.js notify  : 텔레그램(설정된 경우만)
   주기: 외부 호출 30분마다(빠른 회차) + 마지막 1시간 회차로부터 55분이 지나면 1시간 회차 작업을 함께 수행.
   원칙: 검색 결과·요약값은 ‘발견’에만 쓴다. 추천·통계에는 개별 상품 원본에서 확인한 가격·재고만 쓴다. */
'use strict';
const fs = require('fs');
const path = require('path');
const Engine = require('../engine.js');
const ROOT = process.env.CDF_ROOT || path.join(__dirname, '..');
const DB = path.join(ROOT, 'data/db.json');
const STORES = path.join(ROOT, 'data/stores.json');
const TMP = path.join(ROOT, 'tmp');
const REPORT = path.join(ROOT, 'data/scan-report.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HOUR_GAP = 55 * 60 * 1000;
let PAUSE = Number(process.env.CDF_PAUSE ?? 900);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJSON = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1) + '\n'); };
const decodeHtml = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const text = h => decodeHtml(String(h).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const won = s => { const n = Number(String(s).replace(/[^\d]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };

/* ---------- 매칭 ---------- */
const norm = s => String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
const NOT_CD = /(\blp\b|\dlp|엘피|바이닐|vinyl|카세트|cassette|테이프|\btape\b|블루레이|blu-?ray|\bdvd\b|7\s?inch|10인치|12인치)/i;
const IS_CD = /(\bcd\b|\dcd|씨디|시디|shm-?cd|uhqcd|uhq-cd|blu-?spec|hqcd|sacd|종이자켓|디지팩|digipak)/i;
const MERCH = /(퍼즐|티셔츠|반팔|긴팔|후드|맨투맨|포스터|액자|스티커|키링|머그|에코백|엽서|토트백|양말|모자|피규어|그립톡|폰케이스|악보|도서|매거진|잡지|빈\s?케이스|케이스만|공케이스|아크릴)/i;
const WANTED_POST = /(삽니다|구매합니다|구매해요|구합니다|구해요|구해봅니다|매입합니다|사요\b|찾습니다|구매원합니다)/;
const BUNDLE = /(일괄|세트로|묶음|통째|\d+\s?장\s?(?:일괄|모음|세트)|외\s?\d+\s?장|여러\s?장)/;
const names = a => ({ titles: [a.title, ...(a.titleAliases || [])].map(norm).filter(Boolean), artists: [a.artist, ...(a.artistAliases || [])].map(norm).filter(Boolean) });
function hit(s, a) { const n = norm(s), x = names(a); return { title: x.titles.some(t => n.includes(t)), artist: x.artists.some(t => n.includes(t)) }; }
/* 후보 판정: 앨범명·아티스트가 모두 있으면 후보, 아티스트만 있으면 ‘본문 확인 필요’ 후보 */
function classify(title, a, artistText) {
  if (MERCH.test(title) || WANTED_POST.test(title)) return null;
  if (NOT_CD.test(title) && !IS_CD.test(title)) return null;
  const h = hit(title, a), ha = artistText ? hit(artistText, a) : { artist: false };
  if (h.title && (h.artist || ha.artist)) return 'match';
  if (h.artist || ha.artist) return 'body';
  return null;
}
const relevant = (t, a, artistText) => classify(t, a, artistText) === 'match';
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
    const s = keys.filter(k => n.includes(k)).length; if (s > bs) { bs = s; best = e; }
  }
  return best;
}
function hints(t) {
  const h = [], s = String(t || '');
  if (/미개봉|sealed|새상품|새 상품/i.test(s)) h.push('미개봉 표기');
  if (/(북클릿|부클릿|가사집|속지)\s*(없|x|누락|분실)/i.test(s)) h.push('북클릿 누락 표기');
  if (/스크래치|기스|흠집/i.test(s)) h.push('스크래치 언급');
  if (/싸인|사인반/i.test(s)) h.push('사인반 표기');
  if (/일본반|japan/i.test(s)) h.push('일본반 표기');
  if (/리마스터|remaster/i.test(s)) h.push('리마스터 표기');
  if (/해적|부트렉|bootleg|복제/i.test(s)) h.push('비정규반 의심 표현');
  return h;
}
const gradeOf = g => { g = String(g || '').toUpperCase(); if (/^(S|M|NM|최상|미개봉)/.test(g)) return 'S'; if (/^(A|상|EX)/.test(g)) return 'A'; if (/^(B|중|VG)/.test(g)) return 'B'; if (/^(C|하|G)/.test(g)) return 'C'; return '미확인'; };

/* ---------- 네트워크 (요청 기록: 테스트에서 출처별 요청 수 확인) ---------- */
const REQLOG = [];
async function get(url) {
  REQLOG.push(url);
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9', accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(25000), redirect: 'follow' });
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  let body = buf.toString('utf8');
  if (/euc-kr|ks_c_5601|cp949/.test(ct) || (!/utf-8/.test(ct) && /charset=["']?(euc-kr|ks_c_5601)/i.test(body.slice(0, 3000)))) body = new TextDecoder('euc-kr').decode(buf);
  return { status: r.status, final: r.url || url, body };
}
const ldProduct = html => { for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) { try { const j = JSON.parse(m[1]); const arr = j['@graph'] || [j]; const p = arr.find(x => x && x['@type'] === 'Product'); if (p) return p; } catch { } } return null; };
const avail = a => /InStock/i.test(a || '') ? '판매중' : /OutOfStock|SoldOut|Discontinued/i.test(a || '') ? '품절' : /PreOrder|BackOrder/i.test(a || '') ? '입고 예정' : null;

/* 알라딘 배송료 문구 해석: ‘N원 미만 구매시 택배 M원’ / ‘택배 M원’ / ‘무료’ / ‘유료 (N만원 이상 무료)’ */
function aladinShipping(tt, price) {
  let m;
  if ((m = tt.match(/배송료\s*([\d,]+)원 미만 구매시 택배 ([\d,]+)원/))) { const thr = won(m[1]), fee = won(m[2]); return { shipping: price != null && price >= thr ? 0 : fee, ev: `${m[1]}원 미만 택배 ${m[2]}원` }; }
  if ((m = tt.match(/배송료\s*택배\s*([\d,]+)원/))) return { shipping: won(m[1]), ev: `택배 ${m[1]}원` };
  if (/배송료\s*무료/.test(tt)) return { shipping: 0, ev: '배송료 무료' };
  if ((m = tt.match(/배송료 유료 \((\d+)만원 이상 무료/))) { const thr = Number(m[1]) * 10000; return price != null && price >= thr ? { shipping: 0, ev: `${m[1]}만원 이상 무료배송 기준 충족` } : { shipping: null, ev: `${m[1]}만원 미만 — 배송료 금액이 페이지에 없어 총액 미확인` }; }
  return { shipping: null, ev: '배송료 표기 없음' };
}
const cleanPrice = p => (p == null || p <= 1000 || /^9{5,}$/.test(String(p))) ? null : p;   // 1,000원 이하·999999 같은 자리값은 가격으로 쓰지 않음
/* ---------- 출처 어댑터 ----------
   search(album, q) → 후보 [{sid, url, title, price, shipping, kind, delivery, region, shop, needsBody}]
   verify(target)   → {ok:true, status, price, shipping, delivery, isCD, title, text, evidence[], grades, region, bundle, irrelevant} | {ok:false, error} */
const BUNJANG_REASON = 'GitHub 서버(해외 IP)에서 번개장터 검색 API가 404, 상품 페이지는 빈 화면만 응답 — 국내 IP 실행기가 필요해 꺼 둠';
const YES24_REASON = '검색·모바일 검색 요청이 모두 메인 페이지로 리다이렉트됨(해외 서버 차단으로 보임) — 상품 발견 불가';

const aladin = {
  key: 'aladin', label: '알라딘', tier: 'hourly', enabled: () => true,
  async search(a, q) {
    const out = [];
    for (const target of ['Music', 'Used']) {
      const r = await get(`https://www.aladin.co.kr/search/wsearchresult.aspx?SearchTarget=${target}&SearchWord=${encodeURIComponent(q)}`);
      if (r.status !== 200) throw new Error('검색 HTTP ' + r.status);
      const boxes = r.body.split('<div class="ss_book_box"').slice(1, 26);
      for (const b of boxes) {
        const id = (b.match(/itemId="(\d+)"/i) || [])[1]; const tm = b.match(/class="bo3">([\s\S]*?)<\/a>/); if (!id || !tm) continue;
        const title = text(tm[1]); const artistText = text((b.match(/AuthorSearch=[^"]*">([\s\S]*?)<\/a>/) || [])[1] || '');
        if (classify(title, a, artistText) !== 'match') continue;                      // 형식(LP 등)·굿즈 제외 포함
        if (target === 'Music') out.push({ sid: `new:${id}`, url: `https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=${id}`, title, price: won((b.match(/<em>([\d,]+)원<\/em>/) || [])[1]), shipping: null, kind: '신품', shop: '알라딘 (신품)', region: '온라인' });
        if (/wuseditemall\.aspx\?ItemId=\d+&TabType=1/.test(b) && !out.some(x => x.parent === id)) {
          await sleep(PAUSE);
          const u = await get(`https://www.aladin.co.kr/shop/UsedShop/wuseditemall.aspx?ItemId=${id}&TabType=1`);
          if (u.status !== 200) continue;
          for (const row of u.body.split(/<td width="12%" class="sell_tableCF1">/).slice(1, 9)) {
            const uid = (row.match(/wproduct\.aspx\?ItemId=(\d+)/) || [])[1]; if (!uid || out.some(x => x.sid === `used:${uid}`)) continue;
            out.push({ sid: `used:${uid}`, parent: id, url: `https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=${uid}`, title, price: won((row.match(/Ere_fs20 Ere_sub_pink">([\d,]+)</) || [])[1]), shipping: won((row.match(/배송비 : ([\d,]+)원/) || [])[1]), kind: '중고',
              shop: `알라딘 판매자 ${text((row.match(/wshopitem\.aspx\?SC=\d+"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '') || '미상'}`, region: '온라인', grade: text((row.match(/<span class="Ere_sub_top">([^<]+)</) || [])[1] || '') });
          }
        }
      }
      await sleep(PAUSE);
    }
    return out;
  },
  async verify(t) {
    const r = await get(t.url); if (r.status !== 200) return { ok: false, error: 'HTTP ' + r.status };
    const h = r.body, title = text((h.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '');
    const disc = (text(h).match(/Disc\s*:\s*(\d+)장/) || [])[1];
    const isCD = !(NOT_CD.test(title) && !IS_CD.test(title)) && (IS_CD.test(title) || !!disc);
    const catno = (h.match(/og:catno" content="([^"]*)"/) || [])[1] || '';
    if (String(t.sid || t.id).includes('used:')) {
      if (!/^\[중고\]/.test(title)) return { ok: false, error: '중고 개별 상품 페이지가 아님' };
      const tt = text(h), canBuy = /AddBook=U\d+/.test(h) && /바로구매/.test(h), sold = /판매완료|품절되었습니다/.test(tt);
      const uprice = won((h.match(/og:price" content="(\d+)"/) || [])[1]), sh = aladinShipping(tt, uprice);
      const grade = (tt.match(/상품 상태\s*(최상|상|중|하)/) || [])[1];
      return { ok: true, status: canBuy && !sold ? '판매중' : sold ? '판매완료' : '미확인', price: uprice,
        shipping: sh.shipping, isCD, title, text: title + ' ' + catno,
        grades: { disc: grade ? gradeOf(grade) : '미확인' }, seller: (tt.match(/판매자\s+(\S+)\s+출고/) || [])[1] || null,
        evidence: [`개별 중고 상품 ${t.url}`, canBuy ? '바로구매·장바구니 버튼 있음' : '구매 버튼 없음', `판매자 배송료: ${sh.ev}`, grade ? `상태 ${grade}` : '상태 표기 없음'] };
    }
    const p = ldProduct(h); if (!p || !p.offers) return { ok: false, error: '상품 구조화 정보 없음' };
    const price = Number(p.offers.price) || null, st = avail(p.offers.availability) || '미확인';
    const tt = text(h), sh = aladinShipping(tt, price), vendor = (tt.match(/판매 업체\s+(\S+)/) || [])[1];
    return { ok: true, status: st, price, shipping: sh.shipping, isCD, title: p.name || title, text: (p.name || '') + ' ' + catno, seller: vendor ? `입점 ${vendor}` : null,
      evidence: [`상품 페이지 JSON-LD availability=${String(p.offers.availability).split('/').pop()}`, `판매가 ${price}원`, `배송료: ${sh.ev}`, vendor ? `판매 업체 ${vendor}` : '알라딘 직접 판매', disc ? `Disc ${disc}장` : '디스크 수 표기 없음'] };
  }
};

const joongna = {
  key: 'joongna', label: '중고나라', tier: 'fast', enabled: () => true,
  async search(a, q) {
    const r = await get(`https://web.joongna.com/search/${encodeURIComponent(q)}`);
    if (r.status !== 200) throw new Error('검색 HTTP ' + r.status);
    const s = r.body.replace(/\\"/g, '"');
    const i = s.indexOf('"items":[{"seq":'); if (i < 0) return [];
    const unq = x => { let v; try { v = JSON.parse('"' + x + '"'); } catch { v = x; } return String(v).replace(/\\+u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); };
    const out = [];
    for (const c of s.slice(i).split('{"seq":').slice(1, 61)) {
      const f = k => { const m = c.match(new RegExp(`"${k}":("(?:[^"\\\\]|\\\\.)*"|-?\\d+|null)`)); return m ? (m[1][0] === '"' ? unq(m[1].slice(1, -1)) : m[1]) : null; };
      const seq = (c.match(/^(\d+)/) || [])[1], title = f('title'); if (!seq || !title) continue;
      const cl = classify(title, a); if (!cl) continue;
      out.push({ sid: seq, url: `https://web.joongna.com/product/${seq}`, title, price: won(f('price')), shipping: null, kind: '중고', shop: '중고나라 판매자', region: f('mainLocationName') || '지역 미기재', needsBody: cl === 'body' });
    }
    return out;
  },
  async verify(t, a) {
    const r = await get(t.url); if (r.status !== 200) return { ok: false, error: 'HTTP ' + r.status };
    const p = ldProduct(r.body); if (!p || !p.offers) return { ok: false, error: '상품 구조화 정보 없음(삭제 가능성)' };
    const raw = r.body.replace(/\\"/g, '"');
    const num = k => { const m = raw.match(new RegExp(`"${k}":(-?\\d+)`)); return m ? Number(m[1]) : null; };
    const ps = num('productStatus'), hidden = num('productHiddenStatus'), parcelIncl = num('parcelFeeYn');
    const dinfo = [...raw.matchAll(/\{"deliveryType":(\d+),"deliveryPrice":(\d+)\}/g)].map(m => ({ type: +m[1], price: +m[2] }));
    const post = /"isPost":true/.test(raw), meet = /"isMeet":true/.test(raw);
    const desc = String(p.description || ''), title = String(p.name || t.title || ''), cat = (raw.match(/"categoryName":"([^"]*)"/) || [])[1] || '';
    let status = avail(p.offers.availability) || '미확인';
    if (hidden) status = '숨김'; else if (status === '판매중' && ps !== 0) status = '미확인';
    const isCD = (/CD/.test(cat) || IS_CD.test(title) || IS_CD.test(desc.slice(0, 300))) && !(NOT_CD.test(title) && !IS_CD.test(title));
    const bundle = BUNDLE.test(title) || BUNDLE.test(desc.slice(0, 400));
    const body = hit(title + ' ' + desc, a || {});
    const shipping = parcelIncl === 1 ? 0 : dinfo.length ? Math.min(...dinfo.map(d => d.price)) : null;
    const disc = (desc.match(/(?:음반|디스크|CD)\s*[：:]\s*([SABC][+-]?|최상|상|중|하)/i) || [])[1];
    const book = (desc.match(/(?:부클릿|북클릿|속지|가사집)\s*[：:]\s*([SABC][+-]?|최상|상|중|하)/i) || [])[1];
    return { ok: true, status, price: cleanPrice(Number(p.offers.price) || null), shipping: post ? shipping : null, delivery: !post && meet ? '현장' : '배송', isCD, bundle, title, text: title + ' ' + desc,
      irrelevant: t.needsBody ? !(body.title && body.artist) : false, grades: { disc: disc ? gradeOf(disc) : '미확인', booklet: book ? gradeOf(book) : (/(부클릿|북클릿|속지)\s*(없|x|누락)/i.test(desc) ? '누락' : '미확인') },
      evidence: [`상품 페이지 JSON-LD availability=${String(p.offers.availability).split('/').pop()}, productStatus=${ps}`, parcelIncl === 1 ? '배송비 포함' : dinfo.length ? `배송 옵션 ${dinfo.map(d => d.price + '원').join('/')} 중 최저 적용` : '배송비 표기 없음', `카테고리 ${cat || '미상'}`] };
  }
};

const bunjang = { key: 'bunjang', label: '번개장터', tier: 'fast', enabled: () => process.env.BUNJANG === 'on', reason: BUNJANG_REASON,
  async search(a, q) {
    const r = await get(`https://api.bunjang.co.kr/api/1/find_v2.json?q=${encodeURIComponent(q)}&order=date&page=0&n=60`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status} — ${BUNJANG_REASON}`);
    const j = JSON.parse(r.body); return (j.list || []).filter(x => x.pid && classify(String(x.name || ''), a)).map(x => ({ sid: String(x.pid), url: `https://m.bunjang.co.kr/products/${x.pid}`, title: String(x.name), price: won(x.price), shipping: null, kind: '중고', shop: '번개장터 판매자', region: x.location || '지역 미기재' }));
  },
  async verify() { return { ok: false, error: '개별 상품 검증 경로 없음(해외 서버에서 상품 페이지가 빈 화면)' }; } };

const yes24 = { key: 'yes24', label: 'YES24', tier: 'hourly', enabled: () => true,
  async search(a, q) {
    const r = await get(`https://www.yes24.com/Product/Search?domain=ALL&query=${encodeURIComponent(q)}`);
    if (/Main\/default\.aspx|m\.yes24\.com\/home/i.test(r.final)) throw new Error(YES24_REASON);
    throw new Error('검색 결과 구조 미확인 — 파서 미구현');
  },
  async verify() { return { ok: false, error: 'YES24 상품 검증 경로 미구현' }; } };

/* 카페24 기반 음반점 공통 어댑터 */
function cafe24(store) {
  return {
    key: 'store:' + store.id, label: store.name, store, tier: 'hourly', enabled: () => true,
    async search(a, q) {
      if (store.englishOnly && /[^\x00-\x7F]/.test(q)) return [];
      const r = await get(store.url + store.search + encodeURIComponent(q));
      if (r.status !== 200) throw new Error('검색 HTTP ' + r.status);
      const seen = new Set(), out = [];
      const parts = r.body.split(/(?=<li[^>]*id="anchorBoxId_\d+")/);
      for (const part of parts) {
        const id = (part.match(/anchorBoxId_(\d+)/) || [])[1]; if (!id || seen.has(id)) continue; seen.add(id);
        const tx = text(part); const nm = (tx.match(/상품명\s*:\s*(.+?)(?:\s(?:판매가|제조사|제조국|상품간략설명|상품요약정보|자켓|디스크|단독구매상품)\s*:|$)/) || [])[1]; if (!nm) continue;
        const summary = (tx.match(/(?:상품간략설명|상품요약정보)\s*:\s*(\S+)/) || [])[1] || '';
        const full = `${nm} ${summary}`;
        if (store.lpMark && nm.includes(store.lpMark)) continue;
        if (/\b\d?LP\b/i.test(summary) && !IS_CD.test(full)) continue;
        if (classify(nm, a) !== 'match') continue;
        const price = won((tx.match(/판매가\s*:\s*([\d,]+)원/) || [])[1]); if (!price) continue;   // 0원 = 품절 표시
        out.push({ sid: id, url: `${store.url}/product/detail.html?product_no=${id}`, title: nm, price, shipping: null, kind: /미개봉|sealed/i.test(full) ? '신품' : '중고', shop: store.name, region: store.region });
      }
      return out;
    },
    async verify(t) {
      const r = await get(t.url); if (r.status !== 200) return { ok: false, error: 'HTTP ' + r.status };
      const h = r.body, pid = (h.match(/product:productId" content="(\d+)"/) || [])[1];
      if (!pid) return { ok: false, error: '상품 페이지가 아님(공지·소개 페이지는 재고 근거로 쓰지 않음)' };
      const tt = text(h), name = (tt.match(/상품명\s+(.+?)\s+판매가/) || [])[1] || t.title || '';
      const sale = won((h.match(/product:sale_price:amount" content="(\d+)"/) || [])[1]);
      const icon = (h.match(/is_soldout_icon = '(\w)'/) || [])[1];
      const stockRaw = (h.match(/single_option_stock_data = '([^']+)'/) || [])[1];
      let stock = null; try { stock = JSON.parse(stockRaw.replace(/\\"/g, '"')); } catch { }
      const buyBtn = /id="(?:btnBuy|actionBuy)"/.test(h);
      let status = '미확인';
      if (icon === 'T' || (stock && stock.use_stock && stock.stock_number < 1)) status = '품절';
      else if (icon === 'F' && buyBtn && (!stock || !stock.use_stock || stock.stock_number >= 1)) status = '판매중';
      const desc = (tt.match(/음반구분\s+(\S+)/) || [])[1] || (h.match(/og:description" content="([^"]*)"/) || [])[1] || '';
      const fmtTxt = `${name} ${desc}`;
      const isCD = store.lpMark && name.includes(store.lpMark) ? false : IS_CD.test(fmtTxt) ? true : NOT_CD.test(fmtTxt) ? false : store.defaultFormat === 'CD';
      let shipping = null, shipEv = '배송비 표기 없음';
      let m;
      if ((m = tt.match(/배송비\s*([\d,]+)원\s*\(([\d,]+)원 이상 구매 시 무료\)/))) { shipping = sale >= won(m[2]) ? 0 : won(m[1]); shipEv = `배송비 ${m[1]}원 (${m[2]}원 이상 무료)`; }
      else if ((m = tt.match(/배송 비용\s*:\s*([\d,]+)원/))) { shipping = won(m[1]); shipEv = `배송 비용 ${m[1]}원`; }
      else if (/배송 비용\s*:\s*무료|배송비\s*무료/.test(tt)) { shipping = 0; shipEv = '무료배송'; }
      else if ((m = tt.match(/(\d+)만원 미만 구매시\s*:\s*([\d,]+)원/))) { shipping = sale >= Number(m[1]) * 10000 ? 0 : won(m[2]); shipEv = `${m[1]}만원 미만 ${m[2]}원, 이상 무료`; }
      const dg = (tt.match(/(?:디스크|음반상태)\s+([A-C][+-]?|NM|M|EX|VG\+?)/) || [])[1], bg = (tt.match(/(?:북클릿|자켓상태)\s+([A-C][+-]?|NM|M|EX|VG\+?)/) || [])[1];
      return { ok: true, status, price: sale, shipping, isCD, title: name, text: name + ' ' + tt.slice(0, 2000),
        grades: { disc: dg ? gradeOf(dg) : '미확인', booklet: bg ? gradeOf(bg) : '미확인' },
        evidence: [`상품 페이지 productId=${pid}`, `품절 아이콘=${icon || '?'}, 재고=${stock ? (stock.use_stock ? stock.stock_number : '재고관리 안 함') : '?'}, 구매 버튼 ${buyBtn ? '있음' : '없음'}`, shipEv, `형식 근거: ${desc || store.defaultFormat || '없음'}`] };
    }
  };
}
function storeQueries(a) { return [...new Set([a.title, ...(a.titleAliases || []).filter(t => /^[\x00-\x7F]+$/.test(t)), ...queries(a)])].slice(0, 3); }
function adapters() {
  const st = readJSON(STORES, { stores: [] }).stores.filter(s => s.status === 'active' && s.platform === 'cafe24');
  return [joongna, bunjang, aladin, yes24, ...st.map(cafe24)];
}
const byKey = k => adapters().find(x => x.key === k);

/* ---------- fetch: 발견 → 추천 직전 원본 검증 ---------- */
async function doFetch() {
  const db = readJSON(DB), now = Date.now();
  const hourly = process.env.FORCE_HOURLY === '1' || !db.meta || !db.meta.lastHourly || now - db.meta.lastHourly >= HOUR_GAP;
  const albums = db.albums.filter(a => db.editions.some(e => e.albumId === a.id && e.wanted && !e.ended));
  const res = { at: now, hourly, sources: {}, coverage: {}, found: [], verified: {} };
  const cand = new Map();                                           // 같은 매물(출처+ID)은 한 번만
  for (const ad of adapters()) {
    const st = res.sources[ad.key] = { label: ad.label, tier: ad.tier, state: 'ok', searched: 0, failed: 0, candidates: 0, verified: 0, verifyFailed: 0, errors: [] };
    if (!ad.enabled()) { st.state = 'skipped'; st.reason = ad.reason || '꺼짐'; continue; }
    if (ad.tier === 'hourly' && !hourly) { st.state = 'waiting'; st.reason = '1시간 회차에만 조회'; continue; }
    for (const a of albums) {
      let ok = true;
      for (const q of (ad.store ? storeQueries(a) : queries(a))) {
        try { const items = await ad.search(a, q); st.searched++;
          for (const it of items) { const id = `${ad.key}:${it.sid}`; if (!cand.has(id)) { cand.set(id, { id, sourceKey: ad.key, albumId: a.id, it }); st.candidates++; } } }
        catch (e) { ok = false; st.failed++; if (st.errors.length < 4) st.errors.push(`${q}: ${e.message}`); }
        await sleep(PAUSE);
      }
      (res.coverage[a.id] = res.coverage[a.id] || {})[ad.key] = ok;
    }
    st.state = !st.searched ? 'failed' : st.failed ? 'partial' : 'ok';
    if (st.state === 'failed') st.reason = st.errors[0];
  }
  res.found = [...cand.values()];
  /* 검증 대상: 새 후보 + 추적 중인 자동 매물. 그룹(앨범·구분·수령)별로 싼 순서대로, 판매 중으로 검증된 매물 3건이 모일 때까지 */
  const pool = new Map();
  for (const f of res.found) pool.set(f.id, { id: f.id, sourceKey: f.sourceKey, albumId: f.albumId, url: f.it.url, title: f.it.title, sid: f.id, needsBody: f.it.needsBody, est: (f.it.price || 9e9) + (f.it.shipping || 0), kind: f.it.kind });
  for (const l of db.listings) {
    if (!l.auto || pool.has(l.id) || Engine.excludedSource(l) || l.notCD) continue;
    const ed = db.editions.find(e => e.id === l.editionId); if (!ed || !ed.wanted || ed.ended) continue;
    const o = Engine.last(l); if (o.status === '숨김' || Engine.OUT.includes(o.status)) continue;
    pool.set(l.id, { id: l.id, sourceKey: l.sourceKey, albumId: ed.albumId, url: l.url, title: l.title, sid: l.id, est: (o.price || 9e9) + (o.shipping || 0), kind: l.kind, tracked: true });
  }
  const groups = {};
  for (const t of pool.values()) (groups[`${t.albumId}|${t.kind}`] = groups[`${t.albumId}|${t.kind}`] || []).push(t);
  let budget = hourly ? 90 : 30;
  for (const g of Object.values(groups)) {
    g.sort((x, y) => x.est - y.est);
    let good = 0;
    for (const t of g) {
      if (budget <= 0 || good >= 3) break;
      const ad = byKey(t.sourceKey); if (!ad || !ad.verify) continue;
      if (ad.key === 'bunjang') continue;
      const album = db.albums.find(a => a.id === t.albumId);
      let v; try { v = await ad.verify(t, album); } catch (e) { v = { ok: false, error: e.message }; }
      budget--; res.verified[t.id] = v; const st = res.sources[ad.key]; if (st) v.ok ? st.verified++ : st.verifyFailed++;
      if (v.ok && v.status === '판매중' && v.isCD && !v.bundle && !v.irrelevant && v.price != null) good++;
      await sleep(PAUSE);
    }
  }
  res.requests = REQLOG.length; res.requestHosts = [...new Set(REQLOG.map(u => new URL(u).host))];
  writeJSON(path.join(TMP, 'results.json'), res);
  console.log(JSON.stringify({ hourly, sources: res.sources, found: res.found.length, verified: Object.keys(res.verified).length, requests: res.requests }, null, 1));
  return res;
}

/* ---------- merge ---------- */
const OLD_DEFAULT = c => c && c.disc === 'A' && c.case === 'B' && c.booklet === 'A' && !c.userSet;
function pushObs(l, v, at, ver) {
  const prev = Engine.last(l) || { auth: '미확인', authNote: '', match: '미확인', disc: '미확인', case: '미확인', booklet: '미확인' };
  l.obs.push(Object.assign({}, prev, { memo: '' }, v, { at: Math.max(at, prev.at ? prev.at + 1 : 0), via: '자동', ver: !!ver }));
}
function doMerge() {
  const db = readJSON(DB), res = readJSON(path.join(TMP, 'results.json'));
  if (!res) { console.log('결과 없음'); return; }
  db.meta = db.meta || {}; db.alerts = db.alerts || [];
  const at = res.at, touched = new Set();
  /* 1회 이전: 예전 기본 허용 상태(A/B/A)는 사용자가 지정한 필수 조건이 아니므로 ‘상관없음’으로 */
  if ((db.schema || 0) < 3) { for (const e of db.editions) if (OLD_DEFAULT(e.criteria)) Object.assign(e.criteria, { disc: 'ANY', case: 'ANY', booklet: 'ANY' }); db.schema = 3; }
  const keep = l => !l.auto || db.collection.some(c => c.listingId === l.id) || Engine.last(l).status === '숨김' || Engine.excludedSource(l);
  /* 규칙상 관련 없는 자동 매물 정리 (소장·숨김·헬로마켓 기록은 보존) */
  db.listings = db.listings.filter(l => { if (keep(l)) return true; const ed = db.editions.find(e => e.id === l.editionId), a = ed && db.albums.find(x => x.id === ed.albumId); return a && classify(l.title || '', a); });
  const labelOf = k => (res.sources[k] && res.sources[k].label) || k;
  for (const f of res.found) {
    const a = db.albums.find(x => x.id === f.albumId); if (!a) continue;
    let l = db.listings.find(x => x.id === f.id); const it = f.it;
    if (!l) {
      const ed = pickEdition(db, a, it.title); if (!ed) continue;
      l = { id: f.id, sourceKey: f.sourceKey, editionId: ed.id, source: labelOf(f.sourceKey), shop: it.shop, region: it.region, delivery: it.delivery || '배송', kind: it.kind || '중고', url: it.url, title: it.title, hints: hints(it.title), auto: true, firstSeen: at, checkedAt: at, bundle: BUNDLE.test(it.title) || undefined, obs: [] };
      db.listings.push(l);
      pushObs(l, { price: it.price, shipping: it.shipping, status: '미확인', memo: '검색 결과에서 발견 (원본 검증 전)' }, at, false);
    } else { l.checkedAt = at; if (it.shop) l.shop = it.shop; }
    touched.add(l.id);
  }
  for (const [id, v] of Object.entries(res.verified)) {
    const l = db.listings.find(x => x.id === id); if (!l) continue;
    const prevV = l.verify || {};
    l.verify = { at, ok: !!v.ok, okAt: v.ok ? at : prevV.okAt || null, error: v.ok ? null : v.error, evidence: v.ok ? v.evidence : prevV.evidence || [] };
    if (!v.ok) continue;                                                                // 실패한 조회로 성공 시각을 갱신하지 않음
    if (v.irrelevant && !keep(l)) { db.listings = db.listings.filter(x => x !== l); continue; }
    l.notCD = v.isCD ? undefined : true; l.bundle = v.bundle || BUNDLE.test(v.title || l.title) || undefined;
    if (v.title) l.title = v.title; if (v.delivery) l.delivery = v.delivery; if (v.seller && l.sourceKey === 'aladin') l.shop = /^입점/.test(v.seller) ? `알라딘 신품 (${v.seller})` : `알라딘 판매자 ${v.seller}`;
    l.hints = [...new Set([...(l.hints || []), ...hints(v.text || '')])];
    const ed = db.editions.find(e => e.id === l.editionId), o = Engine.last(l);
    let match = o.match || '미확인';
    if (ed && Engine.specific(ed)) { const n = norm(v.text || ''); const keys = [ed.catalogNo, ...(ed.keywords || [])].filter(Boolean).map(norm); match = keys.length && keys.every(k => n.includes(k)) ? '일치' : '미확인'; }
    const status = o.status === '숨김' ? '숨김' : v.status;                           // 사용자가 숨긴 매물은 상태 유지
    const nv = { price: v.price, shipping: v.shipping, status, match, disc: (v.grades && v.grades.disc) || o.disc, booklet: (v.grades && v.grades.booklet) || o.booklet, authNote: o.authNote, memo: '' };
    const lastVer = [...l.obs].reverse().find(x => x.ver);
    if (!lastVer || lastVer.price !== nv.price || lastVer.shipping !== nv.shipping || lastVer.status !== nv.status || lastVer.match !== nv.match || !o.ver) pushObs(l, nv, at, true);
    touched.add(l.id);
  }
  /* 출처별 조회 범위 (앨범 단위) — 실패와 0건을 구분해 앱에 표시 */
  db.meta.coverage = db.meta.coverage || {};
  for (const [aid, m] of Object.entries(res.coverage)) { const c = db.meta.coverage[aid] = db.meta.coverage[aid] || {}; for (const [k, ok] of Object.entries(m)) c[k] = { ok, at }; }
  for (const c of Object.values(db.meta.coverage)) delete c.hellomarket;
  db.meta.sources = Object.assign({}, db.meta.sources || {});
  delete db.meta.sources.hellomarket; delete db.meta.probes;
  for (const [k, s] of Object.entries(res.sources)) { if (s.state === 'waiting' && db.meta.sources[k]) continue; db.meta.sources[k] = { label: s.label, state: s.state, reason: s.reason || null, searched: s.searched, failed: s.failed, candidates: s.candidates, verified: s.verified, verifyFailed: s.verifyFailed, at }; }
  /* 알림 대상: 원본 검증·총액 확인된 매물만 */
  const alerts = [], sent = new Set(db.alerts.map(x => x.key));
  for (const id of touched) {
    const l = db.listings.find(x => x.id === id); if (!l) continue;
    const ed = db.editions.find(e => e.id === l.editionId); if (!ed || !ed.wanted || ed.ended) continue;
    const c = Engine.cheap(db, l, ed); if (!c) continue;
    const key = `${l.id}@${c.value}`; if (sent.has(key)) continue;
    const a = db.albums.find(x => x.id === ed.albumId);
    const al = { key, at, listingId: l.id, album: `${a.artist} — ${a.title}`, edition: ed.name, value: c.value, shippingKnown: true, why: c.why, source: l.source, title: l.title, url: l.url, verifiedAt: l.verify && l.verify.okAt };
    alerts.push(al); db.alerts.push(al);
  }
  db.alerts = db.alerts.filter(x => !/^hellomarket:/.test(x.listingId)).slice(-300);
  db.meta.lastScan = at; if (res.hourly) db.meta.lastHourly = at;
  writeJSON(DB, db);
  writeJSON(REPORT, { at, hourly: res.hourly, sources: res.sources, requests: res.requests, requestHosts: res.requestHosts, verified: Object.fromEntries(Object.entries(res.verified).slice(0, 60).map(([k, v]) => [k, { ok: v.ok, status: v.status, price: v.price, shipping: v.shipping, isCD: v.isCD, error: v.error, evidence: v.evidence }])) });
  writeJSON(path.join(TMP, 'alerts.json'), alerts);
  console.log(`병합: 매물 ${touched.size}건 갱신, 알림 ${alerts.length}건`);
}

/* ---------- notify ---------- */
async function doNotify() {
  const alerts = readJSON(path.join(TMP, 'alerts.json'), []);
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!alerts.length) return console.log('보낼 알림 없음');
  if (!tok || !chat) return console.log(`텔레그램 미설정 — 알림 ${alerts.length}건은 웹앱에만 표시`);
  const fmt = n => n.toLocaleString('ko-KR');
  for (const a of alerts.slice(0, 10)) {
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: `💿 ${a.album} (${a.edition})\n${a.source} · 총 ${fmt(a.value)}원 (배송 포함, 원본 확인)\n${a.why.join(', ')}\n${a.title}\n${a.url}` }) });
    if (!r.ok) console.log('텔레그램 발송 실패', r.status); await sleep(500);
  }
}

if (require.main === module) {
  const mode = process.argv[2];
  ({ fetch: doFetch, merge: doMerge, notify: doNotify }[mode] || (() => { console.log('usage: fetch|merge|notify'); process.exit(1); }))();
}
module.exports = { classify, relevant, pickEdition, hints, norm, adapters, aladin, joongna, yes24, bunjang, cafe24, doFetch, doMerge, REQLOG, setPause: v => { PAUSE = v; } };
