// ===== 전략1: BNF 볼린저밴드 수렴 회귀 =====
import type { Candle } from '../types';
import { calcIndicators } from '../indicators';
import type { StrategyModule, StratRow, OpenPos, ExitEvent, EntryPlan, StratScan } from './types';
import { calcShares, starsFromScore } from './engine';

const PARAMS = { period: 20, stddev: 2, bwLookback: 100, bwPercentile: 25, riskReward: 2, positionPct: 10, minExpectedReturnPct: 0.8 };

function compute(candles: Candle[]): StratRow[] {
  const ind = calcIndicators(candles, { period: PARAMS.period, stddev: PARAMS.stddev, bwLookback: PARAMS.bwLookback, bwPercentile: PARAMS.bwPercentile });
  return ind.map((r) => ({
    time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
    buy: r.buySignal,
    exit: r.upperBand != null && r.close >= r.upperBand, // 상단밴드 도달 = 익절 신호
    lines: { ma20: r.ma20, upper: r.upperBand, lower: r.lowerBand },
    m: {
      bandwidth: r.bandwidth, bwMa20: r.bwMa20, bwPct25: r.bwPct25,
      rsi14: r.rsi14, volMa20: r.volMa20, squeeze: r.isSqueezed ? 1 : 0,
    },
  }));
}

function planEntry(rows: StratRow[], i: number, cash: number): EntryPlan | null {
  const row = rows[i];
  const upper = row.lines.upper;
  const ma20 = row.lines.ma20;
  if (upper == null || ma20 == null) return null;
  const entry = row.close;
  // 최소 기대수익 필터: 중심선(MA20)까지 상승 여력이 minExpectedReturnPct 미만이면 진입 스킵
  // (수수료·슬리피지를 못 넘는 트레이드를 사전 차단)
  const expectedReturnPct = ((ma20 - entry) / entry) * 100;
  if (expectedReturnPct < PARAMS.minExpectedReturnPct) return null;
  const sl = entry - (upper - entry) / PARAMS.riskReward;
  const shares = calcShares(cash, PARAMS.positionPct, entry);
  if (shares <= 0) return null;
  return { entry_price: entry, shares, sl, note: `손절가 ${Math.round(sl).toLocaleString('ko-KR')} (1:${PARAMS.riskReward} 손익비)` };
}

function stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null } {
  const events: ExitEvent[] = [];
  let { shares, sl, tp1_hit } = pos;
  const entry = pos.entry_price;
  const ma20 = row.lines.ma20;
  const upper = row.lines.upper;

  // 1. 손절 (진입 시 설정한 손절가 — 1차 익절 이후에도 본절로 옮기지 않고 그대로 유지되는 하단 안전판)
  if (row.low <= sl) {
    events.push({ side: 'SELL_SL', price: sl, shares, pnl: shares * (sl - entry), note: '손절 청산', time: row.time });
    return { events, updated: null };
  }
  // 2. 1차 익절 (중심선 도달 → 50% 청산)
  if (!tp1_hit && ma20 != null && row.high >= ma20) {
    const half = shares * 0.5;
    events.push({ side: 'SELL_TP1', price: ma20, shares: half, pnl: half * (ma20 - entry), note: '중심선 50% 익절', time: row.time });
    shares -= half;
    tp1_hit = true;
  }
  // 3. 2차 익절 (상단밴드 도달 → 전량 청산)
  if (tp1_hit && upper != null && row.high >= upper) {
    events.push({ side: 'SELL_TP2', price: upper, shares, pnl: shares * (upper - entry), note: '상단밴드 전량 익절', time: row.time });
    return { events, updated: null };
  }
  // 4. 1차 익절 후 중심선 이탈 마감 청산 (기존 '진입가 터치 본절' 대체 — 봉중 노이즈로 인한 스탑아웃 감소)
  if (tp1_hit && ma20 != null && row.close < ma20) {
    events.push({ side: 'SELL_SL', price: row.close, shares, pnl: shares * (row.close - entry), note: '중심선 이탈 마감 청산', time: row.time });
    return { events, updated: null };
  }
  return { events, updated: { ...pos, shares, sl, tp1_hit } };
}

function scan(symbol: string, name: string, rows: StratRow[]): StratScan {
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const price = last?.close ?? 0;
  const changePct = prev ? ((last.close - prev.close) / prev.close) * 100 : 0;
  const bandwidths = rows.map((r) => (r.m.bandwidth ?? null));
  const rank = bwPercentRankLocal(bandwidths);

  const bandwidth = last?.m.bandwidth ?? null;
  const bwPct25 = last?.m.bwPct25 ?? null;
  const bwMa20 = last?.m.bwMa20 ?? null;
  const lower = last?.lines.lower ?? null;
  const volMa20 = last?.m.volMa20 ?? null;
  const rsi14 = last?.m.rsi14 ?? null;

  const bwBelowPctile = bandwidth != null && bwPct25 != null && bandwidth <= bwPct25;
  const bwBelowMa = bandwidth != null && bwMa20 != null && bandwidth < bwMa20;
  const belowLower = lower != null && last.close < lower;
  const nearLower = !belowLower && lower != null && last.close <= lower * 1.02;
  const volUp = volMa20 != null && last.volume > volMa20;
  const rsiOversold = rsi14 != null && rsi14 < 35;
  const notExpanding = bandwidth != null && prev?.m.bandwidth != null && bandwidth <= prev.m.bandwidth * 1.1;
  const recentSqueeze = rows.slice(-5).some((r) => r.m.squeeze === 1);

  const conditions = [
    { label: '밴드폭 하위 25% (수렴)', met: bwBelowPctile, pts: 20 },
    { label: '밴드폭 < 밴드폭 MA20', met: bwBelowMa, pts: 15 },
    { label: '종가 하단밴드 하향 이탈', met: belowLower, pts: 25 },
    { label: '하단밴드 근접 (2% 이내)', met: belowLower || nearLower, pts: 5 },
    { label: '거래량 > 20봉 평균', met: volUp, pts: 10 },
    { label: 'RSI(14) < 35 과매도', met: rsiOversold, pts: 10 },
    { label: '발산(급확장) 아님', met: notExpanding, pts: 5 },
    { label: '최근 5봉 내 수렴 상태', met: recentSqueeze, pts: 10 },
  ];
  const score = conditions.reduce((a, c) => a + (c.met ? c.pts : 0), 0);

  return {
    symbol, name, price, changePct,
    buy: last?.buy ?? false,
    exit: last?.exit ?? false,
    score, stars: starsFromScore(score),
    cols: [
      { value: bandwidth != null ? (bandwidth * 100).toFixed(2) + '%' : '-' },
      { value: rank != null ? `하위 ${rank}%` : '-' },
      { value: last?.m.squeeze === 1 ? '수렴' : '-', tone: last?.m.squeeze === 1 ? 'accent' : 'muted' },
    ],
    conditions,
  };
}

// bwPercentRank 를 StratRow 밴드폭 배열로 재계산 (indicators.bwPercentRank 는 IndicatorRow 기반)
function bwPercentRankLocal(bandwidths: (number | null)[], lookback = 100): number | null {
  const i = bandwidths.length - 1;
  if (i < 0) return null;
  const cur = bandwidths[i];
  if (cur == null) return null;
  const window = bandwidths.slice(Math.max(0, i - lookback + 1), i + 1).filter((v): v is number => v != null);
  if (window.length < 20) return null;
  const below = window.filter((v) => v <= cur).length;
  return Math.round((below / window.length) * 100);
}

export const bnf1: StrategyModule = {
  code: 'bnf1',
  name: 'BNF 전략1 · 볼린저밴드 수렴 회귀',
  short: '15분봉 볼린저밴드 수렴 후 하단밴드 이탈 매수(중심선까지 기대수익 0.8% 이상만) → 중심선 50% 익절 → 상단밴드 전량 익절.',
  interval: '15m',
  range: '60d',
  positionPct: PARAMS.positionPct,
  params: PARAMS,
  lineStyles: [
    { key: 'ma20', color: '#f59e0b', width: 2, label: 'MA20 중심선' },
    { key: 'upper', color: '#22c55e', width: 1, label: '상단밴드 (+2σ)' },
    { key: 'lower', color: '#22c55e', width: 1, label: '하단밴드 (−2σ)' },
  ],
  colHeaders: ['밴드폭', 'BW 백분위', '수렴'],
  rules: [
    { tag: '①', color: 'text-accent', title: '진입', body: '밴드폭 수렴(하위 25% + BW MA20 미만) 상태에서 15분봉 종가가 하단밴드 하향 이탈 시 가용 현금 10% 매수. 발산 구간 제외.' },
    { tag: '②', color: 'text-accent', title: '최소 기대수익 필터', body: '진입가 기준 중심선(MA20)까지 상승 여력이 0.8% 미만이면 매수 스킵. 수수료·슬리피지를 못 넘는 트레이드를 사전 차단.' },
    { tag: '③', color: 'text-amber-400', title: '초기 손절', body: '상단밴드 타겟 거리의 절반만큼 하방 = 1:2 손익비 손절선 설정. 1차 익절 이후에도 본절로 옮기지 않고 그대로 유지.' },
    { tag: '④', color: 'text-profit', title: '1차 익절', body: '중심선(MA20) 도달 시 50% 익절.' },
    { tag: '⑤', color: 'text-profit', title: '2차 익절 · 이탈 청산', body: '잔여 50%는 상단밴드 도달 시 전량 익절. 그전에 15분봉 종가가 중심선 아래로 마감하면 잔여 물량 청산 (봉중 노이즈로 인한 잦은 스탑아웃 방지).' },
  ],
  compute, scan, planEntry, stepOpen,
};
