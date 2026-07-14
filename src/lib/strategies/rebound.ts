// ===== 전략6: 과매도 반등 + 시장 필터 (Oversold Rebound & Market Filter) =====
// 하락장(KOSPI < 200일선)에서 개별 종목이 5일선 아래 + RSI(2) ≤ 10 극단 과매도일 때 매수.
// 종가가 5일선 위로 회복하면 익절, 최대 5영업일 시간 청산. (래리 코너스 RSI2 계열 역추세 전략)
import type { Candle } from '../types';
import type { StrategyModule, StratRow, OpenPos, ExitEvent, EntryPlan, StratScan, CandleFetcher } from './types';
import { calcShares, starsFromScore, smaAt, dailyChangePct } from './engine';

const PARAMS = { rsiPeriod: 2, rsiThresh: 10, smaPeriod: 5, indexSma: 200, maxDays: 5, positionPct: 20 };
const INDEX_SYMBOL = '^KS11'; // KOSPI 지수
const INDEX_TTL = 10 * 60_000;

// ── 시장 지수 캐시 (init 으로 채움) ──
let indexBars: { time: number; close: number; sma200: number | null }[] = [];
let indexLoadedAt = 0;

async function init(fetch: CandleFetcher): Promise<void> {
  if (indexBars.length > 0 && Date.now() - indexLoadedAt < INDEX_TTL) return;
  try {
    const candles = await fetch(INDEX_SYMBOL, '1d', '2y');
    const closes = candles.map((c) => c.close);
    indexBars = candles.map((c, i) => ({ time: c.time, close: c.close, sma200: smaAt(closes, PARAMS.indexSma, i) }));
    indexLoadedAt = Date.now();
  } catch { /* 지수 조회 실패 시 기존 캐시 유지 (없으면 시장필터 판단 불가 → 신호 없음) */ }
}

/** 해당 시점 기준 하락장 여부 (지수 종가 < 지수 SMA200). 판단 불가 시 null */
function bearAt(time: number): boolean | null {
  if (indexBars.length === 0) return null;
  let lo = 0, hi = indexBars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (indexBars[mid].time <= time + 43_200) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0) return null;
  const b = indexBars[ans];
  return b.sma200 == null ? null : b.close < b.sma200;
}

/** RSI(N) — 명세서 방식(단순 rolling 평균) */
function rsiSimple(closes: number[], period: number): (number | null)[] {
  const gains: number[] = [0], losses: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  return closes.map((_, i) => {
    if (i < period) return null;
    let g = 0, l = 0;
    for (let j = i - period + 1; j <= i; j++) { g += gains[j]; l += losses[j]; }
    if (l === 0) return 100;
    const rs = g / l;
    return 100 - 100 / (1 + rs);
  });
}

function compute(candles: Candle[]): StratRow[] {
  const closes = candles.map((c) => c.close);
  const rsi2 = rsiSimple(closes, PARAMS.rsiPeriod);
  return candles.map((c, i) => {
    const sma5 = smaAt(closes, PARAMS.smaPeriod, i);
    const bear = bearAt(c.time);
    const r = rsi2[i];
    const buy = bear === true && sma5 != null && c.close < sma5 && r != null && r <= PARAMS.rsiThresh;
    return {
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      buy,
      exit: sma5 != null && c.close > sma5, // 5일선 회복 = 평균 회귀 익절 신호
      lines: { sma5 },
      m: { rsi2: r, sma5, bear: bear == null ? null : bear ? 1 : 0 },
    };
  });
}

function planEntry(rows: StratRow[], i: number, cash: number): EntryPlan | null {
  const row = rows[i];
  const entry = row.close;
  const shares = calcShares(cash, PARAMS.positionPct, entry);
  if (shares <= 0) return null;
  // 가격 손절 없음 — 5일선 회복 익절 + 최대 5영업일 시간 청산 (sl=0 은 미발동)
  return { entry_price: entry, shares, sl: 0, note: `과매도 반등 매수 (RSI2 ${row.m.rsi2 != null ? (row.m.rsi2 as number).toFixed(1) : '-'}) · 5일선 회귀 목표 · 최대 ${PARAMS.maxDays}일 보유` };
}

function stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null } {
  const entry = pos.entry_price;
  const sma5 = row.lines.sma5;
  // 1. 평균 회귀 익절 (종가 > 5일선)
  if (sma5 != null && row.close > sma5) {
    return { events: [{ side: 'SELL_TP2', price: row.close, shares: pos.shares, pnl: pos.shares * (row.close - entry), note: '5일선 회복 익절', time: row.time }], updated: null };
  }
  // 2. 시간 청산 (최대 5영업일 ≈ 7일)
  const days = (row.time - Math.floor(new Date(pos.opened_at).getTime() / 1000)) / 86400;
  if (days >= PARAMS.maxDays + 2) {
    return { events: [{ side: 'SELL_SL', price: row.close, shares: pos.shares, pnl: pos.shares * (row.close - entry), note: '기간 만료 강제 청산', time: row.time }], updated: null };
  }
  return { events: [], updated: pos };
}

function scan(symbol: string, name: string, rows: StratRow[]): StratScan {
  const last = rows[rows.length - 1];
  const price = last?.close ?? 0;
  const changePct = dailyChangePct(rows);
  const r = (last?.m.rsi2 ?? null) as number | null;
  const sma5 = (last?.m.sma5 ?? null) as number | null;
  const bear = last?.m.bear;

  const isBear = bear === 1;
  const belowSma = sma5 != null && last.close < sma5;
  const oversold = r != null && r <= PARAMS.rsiThresh;
  const panic = r != null && r <= 5;
  const recentSignal = rows.slice(-5).some((x) => x.buy);

  const conditions = [
    { label: '하락장 국면 (KOSPI < 200일선)', met: isBear, pts: 30 },
    { label: '종가 < 5일 이동평균선', met: belowSma, pts: 20 },
    { label: 'RSI(2) ≤ 10 극단 과매도', met: oversold, pts: 35 },
    { label: 'RSI(2) ≤ 5 공포 클라이맥스', met: panic, pts: 10 },
    { label: '최근 5봉 내 매수 신호', met: recentSignal, pts: 5 },
  ];
  const score = conditions.reduce((a, c) => a + (c.met ? c.pts : 0), 0);

  return {
    symbol, name, price, changePct,
    buy: last?.buy ?? false,
    exit: last?.exit ?? false,
    score, stars: starsFromScore(score),
    cols: [
      { value: r != null ? r.toFixed(1) : '-', tone: oversold ? 'accent' : 'default' },
      { value: sma5 != null ? (belowSma ? '아래' : '위') : '-', tone: belowSma ? 'down' : 'up' },
      { value: bear == null ? '판단불가' : isBear ? '하락장' : '상승장', tone: bear == null ? 'muted' : isBear ? 'accent' : 'up' },
    ],
    conditions,
  };
}

export const rebound: StrategyModule = {
  code: 'rebound',
  name: '전략6 · 과매도 반등 + 시장 필터',
  short: '하락장(KOSPI<200일선) 전용 역추세: 5일선 아래 + RSI(2)≤10 극단 과매도 매수 → 5일선 회복 익절, 최대 5영업일 시간 청산.',
  interval: '1d',
  range: '1y',
  positionPct: PARAMS.positionPct,
  params: PARAMS,
  regime: 'BEAR', risk: 4,
  lineStyles: [
    { key: 'sma5', color: '#f59e0b', width: 2, label: 'SMA5 (회귀 목표)' },
  ],
  colHeaders: ['RSI(2)', '5일선 대비', '시장국면'],
  rules: [
    { tag: '①', color: 'text-accent', title: '시장 필터', body: 'KOSPI 지수가 200일 이동평균선 아래(하락장)일 때만 작동하는 하락장 전용 헤지 전략.' },
    { tag: '②', color: 'text-accent', title: '진입', body: '종가가 5일선 아래에 있고 RSI(2)가 10 이하로 떨어진 극단적 공포 시점에 가용 현금 20% 매수.' },
    { tag: '③', color: 'text-profit', title: '익절', body: '종가가 5일 이동평균선 위로 회복 마감하면 미련 없이 전량 익절 (평균 회귀).' },
    { tag: '④', color: 'text-amber-400', title: '시간 청산', body: '가격 손절 대신 시간으로 자름: 5영업일 내 회복 실패 시 손익 무관 강제 청산.' },
  ],
  init, compute, scan, planEntry, stepOpen,
};
