/* cdfinder 판단·통계 엔진 — 웹앱과 수집기가 같이 쓴다. 입력(수집·수동 입력)과 분리된 순수 계산.
   원칙: 자동 수집 매물은 ‘개별 상품 원본 검증’에 성공한 최근 관측만 현재 추천·가격 통계·참고 시세·알림에 쓴다. */
(function (root) {
  'use strict';
  const OUT = ['판매완료', '품절', '숨김', '절판', '예약중', '삭제', '입고 예정', '재고 문의'];
  const RANK = { S: 4, A: 3, B: 2, C: 1 };
  const PARTS = [['disc', '디스크'], ['case', '케이스'], ['booklet', '북클릿']];
  const EXCLUDED_SOURCES = ['hellomarket', '헬로마켓'];          // 수집 중단 판매처: 기록은 보존, 현재 판단에서 제외
  const FRESH_MS = 3 * 3600 * 1000;                               // 원본 검증 유효 시간
  const fmt = n => n.toLocaleString('ko-KR');

  const last = l => l.obs[l.obs.length - 1];
  function lastPriced(l) { for (let i = l.obs.length - 1; i >= 0; i--) if (l.obs[i].price != null) return l.obs[i]; return null; }
  function total(l, o) {
    o = o || last(l);
    if (o.price == null) return null;
    if (l.delivery === '현장') return o.price;
    return o.shipping == null ? null : o.price + o.shipping;       // 배송비 미상 → 총액 미확인
  }
  const excludedSource = l => EXCLUDED_SOURCES.includes(l.sourceKey) || EXCLUDED_SOURCES.includes(l.source);
  const checkedAt = l => Math.max(l.checkedAt || 0, last(l).at, (l.verify && l.verify.at) || 0);
  const verifiedAt = l => (l.auto ? (l.verify && l.verify.okAt) || null : last(l).at);
  /* 판본을 특정했는지: 카탈로그 번호나 구분 단서가 있을 때만 일치 근거를 요구 */
  const specific = ed => !!(ed && (ed.catalogNo || (ed.keywords && ed.keywords.length)));
  function part(g, allow, name) {
    if (!allow || allow === 'ANY') return { ok: 1 };
    if (!g || g === '미확인') return { unknown: 1, t: `${name} 상태 미확인` };
    if (g === '누락') return { fail: 1, t: `${name} 누락` };
    if (RANK[g] < RANK[allow]) return { fail: 1, t: `${name} ${g} — 허용 ${allow} 이상 미달` };
    return { ok: 1 };
  }
  /* 자동 수집 매물의 원본 검증 상태 */
  function current(l, now) {
    if (!l.auto) return { ok: true };
    const v = l.verify; now = now || Date.now();
    if (!v || !v.okAt) return { ok: false, why: '원본 검증 전 — 검색 결과만 확인됨' };
    if (v.at !== v.okAt) return { ok: false, why: '최근 원본 확인 실패' + (v.error ? ` (${v.error})` : '') };
    if (now - v.okAt > FRESH_MS) return { ok: false, why: `원본 확인 후 ${Math.round((now - v.okAt) / 3600000)}시간 경과 — 재확인 대기` };
    return { ok: true };
  }
  /* 목표가와 무관한 조건 검사 (구매 판단·통계·시세·알림 공통) */
  function conditions(l, o, ed) {
    const c = ed.criteria || {}, bad = [], wait = [];
    if (l.notCD) bad.push('CD 아님');
    if (o.auth === '의심') bad.push('정품 의심');
    else if (c.requireAuth && o.auth !== '확인됨') wait.push('정품 근거 미확인 (필수 조건)');
    if (o.match === '불일치') bad.push('판본 불일치');
    else if (specific(ed) && o.match !== '일치') wait.push('판본 일치 근거 없음 (판본 지정됨)');
    PARTS.forEach(([k, n]) => { const p = part(o[k], c[k], n); if (p.fail) bad.push(p.t); else if (p.unknown) wait.push(p.t + ' (필수 조건)'); });
    return { bad, wait };
  }

  function judge(l, ed, now) {
    const o = last(l), c = ed.criteria || {}, tot = total(l, o);
    if (excludedSource(l)) return { v: '제외', r: ['수집 중단 판매처 (헬로마켓) — 기록만 보존'], tot, lastPrice: lastPriced(l) && lastPriced(l).price };
    if (OUT.includes(o.status)) { const lp = lastPriced(l); return { v: '제외', r: [o.status], tot, lastPrice: lp ? (total(l, lp) ?? lp.price) : null }; }
    if (l.notCD) return { v: '제외', r: ['CD 아님 (원본 확인)'], tot };
    const cur = current(l, now);
    if (!cur.ok) return { v: '판매 확인 필요', r: [cur.why], tot };
    if (o.status !== '판매중') return { v: '판매 확인 필요', r: ['판매 가능 상태 근거 없음'], tot };
    const { bad, wait } = conditions(l, o, ed);
    if (bad.length) return { v: '비추천', r: bad, tot };
    const lab = l.delivery === '현장' ? '현장가가' : '배송 포함';
    if (tot == null) wait.push(o.price == null ? '가격 미확인' : '배송비 미확인 — 총액 미확인');
    if (c.target == null) wait.push('목표가 미설정');
    else if (tot != null && tot > c.target) wait.push(`${lab} 목표가보다 ${fmt(tot - c.target)}원 비쌈`);
    if (wait.length) return { v: '관망', r: wait, tot };
    const d = c.target - tot;
    return { v: '구매 추천', r: [d > 0 ? `${lab} 목표가보다 ${fmt(d)}원 저렴` : `${lab} 목표가와 같음`], tot };
  }

  /* 비교 가능 매물: 같은 판본·신품/중고·수령 방식, 판매 중, 원본 검증, 조건 충족, 총액 확인. t를 주면 그 시점 기준 */
  function qualifying(db, ed, kind, delivery, t, now) {
    const items = [];
    for (const l of db.listings) {
      if (l.editionId !== ed.id || l.kind !== kind || (l.delivery || '배송') !== delivery || excludedSource(l) || l.bundle || l.notCD) continue;
      let o = null; for (const x of l.obs) if ((t == null || x.at <= t) && (!l.auto || x.ver)) o = x;
      if (!o || o.status !== '판매중') continue;
      if (t == null && !current(l, now).ok) continue;
      const { bad, wait } = conditions(l, o, ed); if (bad.length || wait.length) continue;
      const tot = total(l, o); if (tot == null) continue;
      items.push({ l, tot, o });
    }
    return items.sort((a, b) => a.tot - b.tot);
  }
  function stats(db, ed, kind, t, delivery, now) {
    const items = qualifying(db, ed, kind, delivery || '배송', t, now);
    if (!items.length) return { count: 0, items };
    const min = items[0].tot;
    return { count: items.length, min, avg: Math.round(items.reduce((a, i) => a + i.tot, 0) / items.length), items, minItems: items.filter(i => i.tot === min) };
  }
  /* 확인된 최저가와 설명 문구 */
  function best(db, ed, kind, delivery, now) {
    const s = stats(db, ed, kind, null, delivery, now); if (!s.count) return null;
    const top = s.items[0], c = ed.criteria || {};
    let why;
    if (c.target != null) why = top.tot <= c.target ? (c.target - top.tot ? `목표가보다 ${fmt(c.target - top.tot)}원 저렴` : '목표가와 같음') : `목표가보다 ${fmt(top.tot - c.target)}원 비쌈`;
    else why = s.count === 1 ? '확인 매물 1건' : `동일 조건 ${s.count}건 중 최저`;
    return { l: top.l, tot: top.tot, why, count: s.count, avg: s.avg, at: verifiedAt(top.l) };
  }
  function change(db, ed, kind, delivery) {
    delivery = delivery || '배송';
    const cur = stats(db, ed, kind, null, delivery); if (!cur.count) return { t: '비교 가능 매물 없음' };
    const times = [...new Set(db.listings.filter(l => l.editionId === ed.id && l.kind === kind && (l.delivery || '배송') === delivery && !excludedSource(l))
      .flatMap(l => l.obs.filter(o => !l.auto || o.ver).map(o => o.at)))].sort((a, b) => a - b);
    if (times.length < 2) return { t: '비교 기록 없음' };
    const tp = times[times.length - 2], prev = stats(db, ed, kind, tp, delivery);
    if (!prev.count) return { t: '비교 기록 없음' };
    const d = cur.min - prev.min; let why = '변동 없음';
    if (d > 0) {
      const pl = prev.minItems[0].l, o = last(pl);
      why = OUT.includes(o.status) ? `기존 최저가 매물 ${o.status}` : !current(pl).ok || o.status !== '판매중' ? '기존 최저가 매물 판매 확인 필요' : total(pl, o) > prev.min ? '기존 최저가 매물 가격 인상' : '기존 최저가 매물 조건 미충족';
    } else if (d < 0) why = cur.minItems.some(i => i.l.obs[0].at > tp) ? '새 매물 등장' : '최저가 하락';
    return { d, t: d === 0 ? '변동 없음' : (d > 0 ? '+' : '−') + fmt(Math.abs(d)) + '원', why, since: tp };
  }
  /* 참고 시세 — 검증 통계와 같은 기준 (중앙값) */
  function ref(db, ed, kind, exceptId, delivery) {
    const v = qualifying(db, ed, kind, delivery || '배송').filter(i => i.l.id !== exceptId).map(i => i.tot);
    if (!v.length) return { n: 0 };
    const m = v.length >> 1;
    return { n: v.length, median: v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2), min: v[0] };
  }
  /* 싼 매물 알림: 원본 검증·조건 충족·총액 확인된 매물이 목표가 이하이거나 동일 조건 시세(3건 이상) 중앙값의 80% 이하 */
  function cheap(db, l, ed) {
    if (l.bundle || excludedSource(l)) return null;
    const j = judge(l, ed); if (j.v !== '구매 추천' && j.v !== '관망') return null;
    if (j.tot == null) return null;                                // 배송비 미상: 상품가만으로 특가 판정하지 않음
    const o = last(l); if (conditions(l, o, ed).wait.length) return null;
    const why = [];
    if (ed.criteria.target != null && j.tot <= ed.criteria.target) why.push(`목표가 ${fmt(ed.criteria.target)}원 이하`);
    const r = ref(db, ed, l.kind, l.id, l.delivery);
    if (r.n >= 3 && j.tot <= r.median * 0.8) why.push(`동일 조건 시세 중앙값 ${fmt(r.median)}원보다 ${Math.round((1 - j.tot / r.median) * 100)}% 쌈`);
    if (!why.length) return null;
    return { value: j.tot, shippingKnown: true, why, verdict: j.v };
  }

  const Engine = { OUT, PARTS, RANK, EXCLUDED_SOURCES, FRESH_MS, last, lastPriced, total, checkedAt, verifiedAt, specific, part, current, conditions, judge, qualifying, stats, best, change, ref, cheap, excludedSource };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine; else root.Engine = Engine;
})(this);
