/* cdfinder 검증 테스트 — 실제 DB의 사본과 실제 페이지 원본(tests/fixtures)으로 실행. 네트워크 사용 안 함.
   node tests/run-tests.js */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const REPO = path.join(__dirname, '..');
const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cdf-'));
fs.mkdirSync(path.join(TMPROOT, 'data'));
fs.copyFileSync(path.join(REPO, 'data/db.json'), path.join(TMPROOT, 'data/db.json'));      // DB 사본
fs.copyFileSync(path.join(REPO, 'data/stores.json'), path.join(TMPROOT, 'data/stores.json'));
process.env.CDF_ROOT = TMPROOT; process.env.CDF_PAUSE = '0'; process.env.FORCE_HOURLY = '1';
const Engine = require('../engine.js');
const S = require('../scanner/run.js');
const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n));
const dbPath = path.join(TMPROOT, 'data/db.json');
const readDb = () => JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const writeDb = d => fs.writeFileSync(dbPath, JSON.stringify(d));
let routes = {};                                                       // url 정규식 → () => {status, body, final}
global.fetch = async url => {
  for (const [re, fn] of Object.entries(routes)) if (new RegExp(re).test(url)) { const r = fn(url); return { status: r.status || 200, url: r.final || url, headers: { get: () => 'text/html; charset=utf-8' }, arrayBuffer: async () => Buffer.from(r.body || '') }; }
  return { status: 404, url, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from('') };
};
const res = []; const ok = (name, cond, extra = '') => { res.push([cond ? 'PASS' : 'FAIL', name, cond ? '' : extra]); };
const HOUR = 3600e3;
const mkL = (id, ed, price, shipping, extra = {}) => ({ id, sourceKey: 'test', editionId: ed, source: '테스트', shop: id, region: '온라인', delivery: '배송', kind: '중고', auto: true, url: 'https://example.test/' + id,
  verify: { at: Date.now() - 1000, ok: true, okAt: Date.now() - 1000 }, obs: [{ at: Date.now() - 2000, price, shipping, status: '판매중', auth: '미확인', match: '미확인', disc: '미확인', case: '미확인', booklet: '미확인', ver: true }], ...extra });

(async () => {
  /* ── 실제 페이지 원본 파서 ── */
  let v = await (routes = { 'ItemId=400766131': () => ({ body: fx('aladin_used_400766131.html') }) }, S.aladin.verify({ sid: 'used:400766131', url: 'https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=400766131' }));
  ok('알라딘 판매자 중고 원본: 판매중·20,000원·판매자 배송료 3,500원·CD', v.ok && v.status === '판매중' && v.price === 20000 && v.shipping === 3500 && v.isCD, JSON.stringify(v));
  v = await (routes = { 'ItemId=703384': () => ({ body: fx('aladin_new_703384_outofstock.html') }) }, S.aladin.verify({ sid: 'new:703384', url: 'https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=703384' }));
  ok('알라딘 신품 원본 JSON-LD OutOfStock → 품절', v.ok && v.status === '품절' && v.isCD, JSON.stringify(v));
  v = await (routes = { 'joongna': () => ({ body: fx('joongna_233981060.html') }) }, S.joongna.verify({ url: 'https://web.joongna.com/product/233981060' }, { title: 'Abbey Road', artist: 'The Beatles', titleAliases: ['애비로드'], artistAliases: ['비틀즈'] }));
  ok('중고나라 원본: InStock·29,000원·배송 옵션 최저 2,500원·CD', v.ok && v.status === '판매중' && v.price === 29000 && v.shipping === 2500 && v.isCD, JSON.stringify(v));
  const soriah = S.cafe24({ id: 'soriah', name: '소리아', region: '서울', url: 'https://soriah.co.kr', search: '/product/search.html?keyword=' });
  v = await (routes = { 'soriah': () => ({ body: fx('soriah_34022_soldout.html') }) }, soriah.verify({ url: 'https://soriah.co.kr/product/detail.html?product_no=34022' }));
  ok('음반점(소리아) 원본: 품절 아이콘·재고 0 → 품절, 배송비 4,000원', v.ok && v.status === '품절' && v.shipping === 4000 && v.isCD, JSON.stringify(v));
  const cdloft = S.cafe24({ id: 'cdloft', name: '시디로프트', region: '서울', url: 'https://cdloft.co.kr', search: '/product/search.html?keyword=', defaultFormat: 'CD', lpMark: '[LP]' });
  v = await (routes = { 'cdloft': () => ({ body: fx('cdloft_468125.html') }) }, cdloft.verify({ url: 'https://cdloft.co.kr/product/detail.html?product_no=468125' }));
  ok('음반점(시디로프트) 원본: 재고 1·판매중·4만원 미만 배송비 3,000원', v.ok && v.status === '판매중' && v.price === 12800 && v.shipping === 3000, JSON.stringify(v));
  const cd4 = S.cafe24({ id: 'cd4love', name: 'CD4LOVE', region: '울산', url: 'https://cd4love.co.kr', search: '/product/search.html?keyword=' });
  v = await (routes = { 'cd4love': () => ({ body: fx('cd4love_1741.html') }) }, cd4.verify({ url: 'https://cd4love.co.kr/product/detail.html?product_no=1741' }));
  ok('음반점(CD4LOVE) 원본: 판매중·16,500원·배송비 3,000원·CD', v.ok && v.status === '판매중' && v.price === 16500 && v.shipping === 3000 && v.isCD, JSON.stringify(v));
  /* 알라딘 배송료 문구: 기준금액을 배송비로 잘못 읽지 않음 */
  {
    const page = (title, price, ship) => `<meta property="og:title" content="${title}"/><meta property="og:price" content="${price}" /><a href="/shop/wbasket.aspx?AddBook=U123">장바구니</a> 바로구매 상품 상태 중 ${ship} 판매자 X 출고예상일 Disc : 1장`;
    routes = { 'ItemId=1$': () => ({ body: page('[중고] Chet Baker - Sings', 13000, '배송료 80,000원 미만 구매시 택배 3,700원, 도서/산간 6,200원') }), 'ItemId=2$': () => ({ body: page('[중고] Chet Baker - Sings', 90000, '배송료 80,000원 미만 구매시 택배 3,700원') }) };
    const v1 = await S.aladin.verify({ sid: 'used:1', url: 'https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=1' });
    const v2 = await S.aladin.verify({ sid: 'used:2', url: 'https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=2' });
    ok('알라딘 ‘80,000원 미만 구매시 택배 3,700원’ → 13,000원 상품 배송비 3,700원, 90,000원 상품 0원', v1.shipping === 3700 && v2.shipping === 0, JSON.stringify([v1.shipping, v2.shipping]));
  }
  /* ⑤ 과거 입고 공지만 있는 경우 */
  v = await (routes = { 'cdloft': () => ({ body: '<html><title>공지</title><body>[입고 안내] Chet Baker - Chet Baker Sings CD 입고되었습니다! 판매가 15,000원</body></html>' }) }, cdloft.verify({ url: 'https://cdloft.co.kr/board/notice/read.html?no=1' }));
  ok('음반점 입고 공지 페이지 → 상품 페이지 아님, 재고로 인정 안 함', !v.ok && /상품 페이지가 아님/.test(v.error), JSON.stringify(v));
  /* 검색 파서 */
  const chet = { id: 'x', title: 'Chet Baker Sings', artist: 'Chet Baker', titleAliases: [], artistAliases: ['쳇 베이커'] };
  routes = { 'wsearchresult.*Music': () => ({ body: fx('aladin_search_music.html') }), 'wsearchresult.*Used': () => ({ body: '<html></html>' }), 'wuseditemall': () => ({ body: fx('aladin_usedall_703384.html') }) };
  let found = await S.aladin.search(chet, 'chet baker sings');
  ok('알라딘 검색: LP 상품 제외, CD 신품 후보와 판매자별 중고 후보 분리', found.length > 0 && found.every(f => !/\bLP\b/i.test(f.title)) && found.some(f => f.sid.startsWith('used:')) && found.some(f => f.sid.startsWith('new:')), JSON.stringify(found.map(f => f.sid + ' ' + f.title)).slice(0, 400));
  const usedRows = found.filter(f => f.sid.startsWith('used:'));
  ok('알라딘 판매자 중고: 판매자마다 개별 ID·판매가·배송비', usedRows.length >= 3 && usedRows.every(r => r.price && r.shipping === 3500) && new Set(usedRows.map(r => r.sid)).size === usedRows.length, JSON.stringify(usedRows).slice(0, 300));
  routes = { 'cdloft': () => ({ body: fx('cdloft_search_chet.html') }) };
  found = await cdloft.search({ title: 'Big Band', artist: 'Chet Baker' }, 'chet baker');
  ok('음반점 검색 파서: 시디로프트 검색 결과에서 상품 번호·가격 추출', found.length >= 1 && found[0].price > 0, JSON.stringify(found));
  /* ② 제외 대상 */
  const ab = { title: 'Abbey Road', artist: 'The Beatles', titleAliases: ['애비로드'], artistAliases: ['비틀즈'] };
  const cases = { '비틀즈 애비로드 LP 미개봉': null, '비틀즈 애비로드 빈 케이스': null, '비틀즈 애비로드 CD 구합니다': null, '비틀즈 애비로드 카세트 테이프': null, '비틀즈 애비로드 CD': 'match', '비틀즈 앨범 판매': 'body' };
  ok('LP·빈 케이스·구매글·카세트 제외, 모호한 제목은 본문 확인 후보', Object.entries(cases).every(([t, e]) => S.classify(t, ab) === e), JSON.stringify(Object.keys(cases).map(t => [t, S.classify(t, ab)])));
  ok('일괄 판매글(개별 가격·재고 불명)은 시세·추천 제외', (() => { const ed = { id: 'e', criteria: {} }; const db = { listings: [mkL('b1', 'e', 30000, 0, { bundle: true })] }; return Engine.best(db, ed, '중고', '배송') === null; })());

  /* ③ 배송비: 25,000원(배송비 미상) / 25,000+4,000 / 28,000 무료 → 확인된 배송 최저가 28,000 */
  {
    const ed = { id: 'e3', criteria: { target: null } };
    const db = { listings: [mkL('a', 'e3', 25000, null), mkL('b', 'e3', 25000, 4000), mkL('c', 'e3', 28000, 0)] };
    const b = Engine.best(db, ed, '중고', '배송');
    ok('배송비 미상 25,000 / 25,000+4,000 / 무료 28,000 → 확인된 최저 28,000원', b && b.tot === 28000 && b.l.id === 'c' && b.count === 2 && b.why === '동일 조건 2건 중 최저', JSON.stringify(b && { tot: b.tot, id: b.l.id, why: b.why }));
    ok('배송비 미상 매물은 관망(총액 미확인)·알림 없음', Engine.judge(db.listings[0], { ...ed, criteria: { target: 30000 } }).v === '관망' && Engine.cheap(db, db.listings[0], { ...ed, criteria: { target: 30000 } }) === null);
    const edT = { id: 'e3', criteria: { target: 31000 } };
    ok('목표가 이유 문구: ‘목표가보다 3,000원 저렴’', Engine.best(db, edT, '중고', '배송').why === '목표가보다 3,000원 저렴');
    ok('한 건뿐이면 ‘확인 매물 1건’', Engine.best({ listings: [mkL('z', 'e3', 20000, 0)] }, ed, '중고', '배송').why === '확인 매물 1건');
  }
  /* ② 요약 최저가만 확인 (원본 검증 없음) → 추천 안 됨 */
  {
    const ed = { id: 'e4', criteria: { target: 50000 } };
    const l = mkL('sum', 'e4', 15000, 0); delete l.verify; l.obs[0].ver = false;
    ok('검색 요약 최저가만 확인된 매물 → 판매 확인 필요, 최저가·추천 제외', Engine.judge(l, ed).v === '판매 확인 필요' && Engine.best({ listings: [l] }, ed, '중고', '배송') === null);
    const stale = mkL('st', 'e4', 15000, 0, { verify: { at: Date.now() - 5 * HOUR, ok: true, okAt: Date.now() - 5 * HOUR } });
    ok('원본 검증이 오래된 매물(5시간) → 현재 추천 제외', Engine.judge(stale, ed).v === '판매 확인 필요');
    const failed = mkL('fl', 'e4', 15000, 0, { verify: { at: Date.now(), ok: false, okAt: Date.now() - HOUR, error: 'HTTP 503' } });
    ok('최근 재검증 실패 → 이전 성공 기록으로 대체하지 않음', Engine.judge(failed, ed).v === '판매 확인 필요' && /실패/.test(Engine.judge(failed, ed).r[0]));
  }

  /* ── 수집기 전체 흐름: DB 사본으로 fetch → merge ── */
  const db0 = readDb();
  const abbey = db0.albums.find(a => a.title === 'Abbey Road');
  const edAb = db0.editions.find(e => e.albumId === abbey.id);
  edAb.criteria.target = 40000;
  db0.listings = db0.listings.filter(l => !(l.auto && l.editionId === edAb.id));   // 시나리오 격리: 이 앨범의 실조회 매물만 비움 (다른 데이터는 그대로)
  // 보존 확인용: 수동 매물을 숨김, 소장 기록 추가, 헬로마켓 과거 매물 추가
  const hidden = { id: 'manual-hidden', editionId: edAb.id, source: '번개장터', shop: '직접', region: '서울', delivery: '배송', kind: '중고', auto: false, obs: [{ at: Date.now() - HOUR, price: 10000, shipping: 0, status: '숨김', auth: '미확인', match: '미확인', disc: '미확인', case: '미확인', booklet: '미확인' }] };
  const hm = { id: 'hellomarket:999', sourceKey: 'hellomarket', editionId: edAb.id, source: '헬로마켓', shop: '헬로마켓 판매자', region: '서울', delivery: '배송', kind: '중고', auto: true, url: 'https://www.hellomarket.com/item/999', title: '비틀즈 애비로드 CD', verify: { at: Date.now(), ok: true, okAt: Date.now() }, obs: [{ at: Date.now() - 100, price: 5000, shipping: 0, status: '판매중', ver: true, auth: '미확인', match: '미확인', disc: '미확인', case: '미확인', booklet: '미확인' }] };
  db0.listings.push(hidden, hm);
  db0.collection.push({ id: 'own-test', albumId: abbey.id, editionId: edAb.id, listingId: null, source: '테스트', price: 1, date: '2026-11-20' });
  const wishBefore = db0.albums.length + '/' + db0.editions.length;
  writeDb(db0);
  const jnItems = (n) => `<script>self.__next_f.push([1,"{\\"totalSize\\":2,\\"items\\":[{\\"seq\\":111,\\"price\\":30000,\\"title\\":\\"비틀즈 애비로드 CD\\",\\"state\\":0,\\"mainLocationName\\":\\"\\"},{\\"seq\\":222,\\"price\\":33000,\\"title\\":\\"The Beatles Abbey Road CD 비틀즈\\",\\"state\\":0,\\"mainLocationName\\":\\"\\"}]}"])</script>`;
  const jnProduct = (seq, price, avail, ship) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'Product', name: '비틀즈 애비로드 CD', description: 'The Beatles Abbey Road CD 음반: A', offers: { price, availability: 'https://schema.org/' + avail } }] })}</script><script>"productStatus":${avail === 'InStock' ? 0 : 3},"productHiddenStatus":0,"categoryName":"도서/음반/문구,음반/DVD/굿즈,CD","parcelFeeYn":0,"deliveryInfos":[{"deliveryType":0,"deliveryPrice":${ship}}],"tradeType":{"isPost":true,"isMeet":false}</script>`;
  let soldCheapest = false;
  routes = {
    'web\\.joongna\\.com/search': () => ({ body: jnItems() }),
    'joongna\\.com/product/111': () => ({ body: jnProduct(111, 30000, soldCheapest ? 'SoldOut' : 'InStock', 3000) }),
    'joongna\\.com/product/222': () => ({ body: jnProduct(222, 33000, 'InStock', 3000) }),
    'aladin\\.co\\.kr/search': () => ({ status: 503, body: '' }),                                // 알라딘 조회 실패
    'yes24': () => ({ body: '<html>main</html>', final: 'https://www.yes24.com/Main/default.aspx' }),
    '.': () => ({ body: '<html>검색결과가 없습니다</html>' })                                       // 음반점: 0건
  };
  S.REQLOG.length = 0;
  await S.doFetch(); S.doMerge();
  let d = readDb(); let ed = d.editions.find(e => e.id === edAb.id);
  let b = Engine.best(d, ed, '중고', '배송');
  ok('수집 흐름: 원본 검증된 최저가 33,000원(30,000+3,000)이 추천', b && b.tot === 33000 && b.l.id === 'joongna:111', JSON.stringify(b && { tot: b.tot, id: b.l.id }));
  ok('헬로마켓 검색·재확인 요청 0건', !S.REQLOG.some(u => /hellomarket/.test(u)), S.REQLOG.filter(u => /hellomarket/.test(u)).join());
  ok('과거 헬로마켓 매물(5,000원)은 최저가·추천에 영향 없음, 기록은 보존', d.listings.some(l => l.id === 'hellomarket:999') && Engine.judge(d.listings.find(l => l.id === 'hellomarket:999'), ed).v === '제외' && b.tot !== 5000);
  const cov = d.meta.coverage[abbey.id];
  ok('출처 실패와 0건 구분: 알라딘 실패, 중고나라·음반점 성공, YES24 실패', cov.aladin.ok === false && cov.joongna.ok === true && cov['store:cdloft'].ok === true && cov.yes24.ok === false, JSON.stringify(cov));
  ok('출처 상태에 실패 사유 기록 (YES24 리다이렉트, 번개장터 꺼짐)', /리다이렉트/.test(d.meta.sources.yes24.reason || '') && d.meta.sources.bunjang.state === 'skipped' && /해외 IP/.test(d.meta.sources.bunjang.reason), JSON.stringify(d.meta.sources.yes24));
  /* ⑦ 같은 매물이 여러 검색어로 잡혀도 1건 */
  ok('같은 매물이 검색어 2개에 모두 잡혀도 한 건으로 집계', d.listings.filter(l => l.id === 'joongna:111').length === 1 && Engine.stats(d, ed, '중고', null, '배송').count === 2);
  /* ④ 추천 직전 최저가 품절 → 다음 검증 매물 */
  soldCheapest = true; d.meta.lastHourly = Date.now(); writeDb(d); process.env.FORCE_HOURLY = '';
  await S.doFetch(); S.doMerge();
  d = readDb(); ed = d.editions.find(e => e.id === edAb.id); b = Engine.best(d, ed, '중고', '배송');
  const sold = d.listings.find(l => l.id === 'joongna:111');
  ok('추천 직전 최저가 품절 → 제외되고 다음 검증 매물(36,000원)이 표시', b && b.l.id === 'joongna:222' && b.tot === 36000 && Engine.judge(sold, ed).v === '제외', JSON.stringify(b && { id: b.l.id, tot: b.tot }));
  const ch = Engine.change(d, ed, '중고', '배송');
  ok('최저가 상승 이유: ‘기존 최저가 매물 판매완료/품절’로 설명 (가격 인상으로 기록 안 함)', /기존 최저가 매물 (품절|판매완료)/.test(ch.why || '') && ch.d === 3000, JSON.stringify(ch));
  ok('품절 매물의 마지막 가격 이력 보존', sold.obs.some(o => o.price === 30000 && o.status === '판매중'));
  /* ⑥ 병합 후 보존 */
  ok('희망 목록·판본 개수 유지', d.albums.length + '/' + d.editions.length === wishBefore);
  ok('소장 기록 유지', d.collection.some(c => c.id === 'own-test'));
  ok('숨김 상태 유지', Engine.last(d.listings.find(l => l.id === 'manual-hidden')).status === '숨김');
  ok('예전 기본 허용 상태(A/B/A)는 ‘상관없음’으로 1회 전환', d.schema === 3 && d.editions.every(e => e.criteria.disc === 'ANY' || e.criteria.userSet));
  /* 예전 데이터(검증 필드 없음)도 판단 가능 */
  const old = { id: 'old', editionId: 'x', source: '중고나라', auto: true, delivery: '배송', kind: '중고', obs: [{ at: 1, price: 1000, shipping: null, status: '판매중' }] };
  ok('예전 자동 매물(검증 필드 없음)도 오류 없이 ‘판매 확인 필요’', Engine.judge(old, { id: 'x', criteria: {} }).v === '판매 확인 필요');

  const fails = res.filter(r => r[0] === 'FAIL');
  for (const r of res) console.log(r[0], r[1], r[2] ? '\n   ' + String(r[2]).slice(0, 400) : '');
  console.log(`\n${res.length - fails.length}/${res.length} 통과`);
  fs.rmSync(TMPROOT, { recursive: true, force: true });
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
