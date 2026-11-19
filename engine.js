/* cdfinder 판단·통계 엔진 — 웹앱과 수집기가 같이 쓴다. 입력(수집·수동 입력)과 분리된 순수 계산. */
(function (root) {
  'use strict';
  const OUT = ['판매완료', '품절', '숨김'];
  const RANK = { S: 4, A: 3, B: 2, C: 1 };
  const PARTS = [['disc', '디스크'], ['case', '케이스'], ['booklet', '북클릿']];
  const fmt = n => n.toLocaleString('ko-KR');

  const last = l => l.obs[l.obs.length - 1];
  function lastPriced(l) { for (let i = l.obs.length - 1; i >= 0; i--) if (l.obs[i].price != null) return l.obs[i]; return null; }
  function total(l, o) {
    o = o || last(l);
    if (o.price == null) return null;
    if (l.delivery === '현장') return o.price;
    return o.shipping == null ? null : o.price + o.shipping;
  }
  const checkedAt = l => Math.max(l.checkedAt || 0, last(l).at);
  function part(g, allow, name) {
    if (allow === 'ANY') return { ok: 1 };
    if (!g || g === '미확인') return { unknown: 1, t: `${name} 상태 미확인` };
    if (g === '누락') return { fail: 1, t: `${name} 누락` };
    if (RANK[g] < RANK[allow]) return { fail: 1, t: `${name} ${g} — 허용 ${allow} 이상 미달` };
    return { ok: 1 };
  }
  /* 통계 자격: 정품 확인·판본 일치·허용 상태 충족 (목표가와 무관) */
  const eligible = (o, ed) => o.auth === '확인됨' && o.match === '일치' && PARTS.every(([k, n]) => part(o[k], ed.criteria[k], n).ok);

  function judge(l, ed) {
    const o = last(l), c = ed.criteria, tot = total(l, o);
    if (OUT.includes(o.status)) {
      const lp = lastPriced(l);
      return { v: '제외', r: [o.status], tot, lastPrice: lp ? (total(l, lp) ?? lp.price) : null };
    }
    if (o.status !== '판매중') return { v: '판매 확인 필요', r: ['판매 여부 불명확'], tot };
    const bad = [], wait = [];
    if (o.auth === '의심') bad.push('정품 의심');
    if (o.match === '불일치') bad.push('판본 불일치');
    PARTS.forEach(([k, n]) => { const p = part(o[k], c[k], n); if (p.fail) bad.push(p.t); else if (p.unknown) wait.push(p.t); });
    if (bad.length) return { v: '비추천', r: bad, tot };
    const lab = l.delivery === '현장' ? '현장가가' : '배송 포함';
    if (o.auth === '미확인') wait.push('정품 근거 미확인');
    if (o.match === '미확인') wait.push('판본 일치 미확인');
    if (tot == null) wait.push(o.price == null ? '가격 미확인' : '배송비 미확인');
    if (c.target == null) wait.push('목표가 미설정');
    else if (tot != null && tot > c.target) wait.push(`${lab} 목표가보다 ${fmt(tot - c.target)}원 비쌈`);
    if (wait.length) return { v: '관망', r: wait, tot };
    const d = c.target - tot;
    return { v: '구매 추천', r: [d > 0 ? `${lab} 목표가보다 ${fmt(d)}원 저렴` : `${lab} 목표가와 같음`, '정품 근거·판본·허용 상태 충족'], tot };
  }

  /* 검증된 가격 통계 — t를 주면 그 시점의 관측으로 계산 */
  function stats(db, ed, kind, t) {
    const items = [];
    for (const l of db.listings) {
      if (l.editionId !== ed.id || l.kind !== kind) continue;
      let o = null; for (const x of l.obs) if (t == null || x.at <= t) o = x;
      if (!o || o.status !== '판매중' || !eligible(o, ed)) continue;
      const tot = total(l, o); if (tot == null) continue;
      items.push({ l, tot });
    }
    if (!items.length) return { count: 0, items };
    const min = Math.min(...items.map(i => i.tot));
    return { count: items.length, min, avg: Math.round(items.reduce((a, i) => a + i.tot, 0) / items.length), items, minItems: items.filter(i => i.tot === min) };
  }
  function change(db, ed, kind) {
    const cur = stats(db, ed, kind); if (!cur.count) return { t: '비교 가능 매물 없음' };
    const times = [...new Set(db.listings.filter(l => l.editionId === ed.id && l.kind === kind).flatMap(l => l.obs.map(o => o.at)))].sort((a, b) => a - b);
    if (times.length < 2) return { t: '비교 기록 없음' };
    const tp = times[times.length - 2], prev = stats(db, ed, kind, tp);
    if (!prev.count) return { t: '비교 기록 없음' };
    const d = cur.min - prev.min; let why = '변동 없음';
    if (d > 0) {
      const o = last(prev.minItems[0].l);
      why = OUT.includes(o.status) ? `기존 최저가 매물 ${o.status}` : o.status !== '판매중' ? '기존 최저가 매물 판매 확인 필요' : !eligible(o, ed) ? '기존 최저가 매물 조건 미충족' : '기존 최저가 매물 가격 인상';
    } else if (d < 0) why = cur.minItems.some(i => i.l.obs[0].at > tp) ? '새 매물 등장' : '최저가 하락';
    return { d, t: d === 0 ? '변동 없음' : (d > 0 ? '+' : '−') + fmt(Math.abs(d)) + '원', why, since: tp };
  }
  /* 참고 시세 — 미검증 매물 포함(정품 의심·판본 불일치 제외), 총액 확인된 판매 중 매물의 중앙값 */
  function ref(db, ed, kind, exceptId) {
    const v = [];
    for (const l of db.listings) {
      if (l.editionId !== ed.id || l.kind !== kind || l.id === exceptId) continue;
      const o = last(l); if (o.status !== '판매중' || o.auth === '의심' || o.match === '불일치') continue;
      const t = total(l, o); if (t != null) v.push(t);
    }
    if (!v.length) return { n: 0 };
    v.sort((a, b) => a - b); const m = v.length >> 1;
    return { n: v.length, median: v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2), min: v[0] };
  }
  /* 싼 매물 알림 조건: 목표가 이하, 또는 참고 시세(3건 이상) 중앙값의 80% 이하 */
  function cheap(db, l, ed) {
    const j = judge(l, ed); if (j.v !== '구매 추천' && j.v !== '관망') return null;
    const o = last(l); if (o.price == null) return null;
    const value = j.tot ?? o.price, why = [];
    if (ed.criteria.target != null && value <= ed.criteria.target) why.push(`목표가 ${fmt(ed.criteria.target)}원 이하`);
    const r = ref(db, ed, l.kind, l.id);
    if (r.n >= 3 && value <= r.median * 0.8) why.push(`참고 시세 중앙값 ${fmt(r.median)}원보다 ${Math.round((1 - value / r.median) * 100)}% 쌈`);
    if (!why.length) return null;
    return { value, shippingKnown: j.tot != null, why, verdict: j.v };
  }

  const Engine = { OUT, PARTS, RANK, last, lastPriced, total, checkedAt, part, eligible, judge, stats, change, ref, cheap };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine; else root.Engine = Engine;
})(this);
