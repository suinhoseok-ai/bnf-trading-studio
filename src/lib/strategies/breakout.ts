// ===== 전략2: 추세 돌파 + 거래량 급증 (Breakout) =====
// 60일 최고가 상향 돌파 + 거래량 2.5배 급증 시 매수. 돌파캔들 저가 손절, EMA20 이탈 시 추세 청산.
import type { Candle } from '../types';
import type { StrategyModule, StratRow, OpenPos, ExitEvent, EntryPlan, StratScan } from './types';
import { calcShares, starsFromScore, emaArr, maxOfPrev, meanOfPrev } from './engine';

const PARAMS = { resPeriod: 60, volMaPeriod: 20, volMult: 2.5, emaPeriod: 20, positionPct: 20 };

function compute(candles: Candle[]): StratRow[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const volumes = candles.map((c) => c.volume);
  const ema = emaArr(closes, PARAMS.emaPeriod);

  return candles.map((c, i) => {
    const highest = maxOfPrev(highs, PARAMS.resPeriod, i);
    const volMa = meanOfPrev(volumes, PARAMS.volMaPeriod, i);
    const isBreakout = highest != null && c.close > highest;
    const isVolSurge = volMa != null && volMa > 0 && c.volume >= volMa * PARAMS.volMult;
    return {
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      buy: !!(isBreakout && isVolSurge),
      exit: c.close < ema[i], // EMA20 하향 이탈 = 추세 청산 신호
      lines: { high60: highest, ema20: ema[i] },
      m: { volMa, volRatio: volMa && volMa > 0 ? c.volume / volMa : null, ema20: ema[i], highest },
    };
  });
}

function planEntry(rows: StratRow[], i: number, cash: number): EntryPlan | null {
  const row = rows[i];
  const entry = row.close;
  const sl = row.low; // 돌파 캔들 저가 = 절대 손절선
  const shares = calcShares(cash, PARAMS.positionPct, entry);
  if (shares <= 0) return null;
  return { entry_price: entry, shares, sl, note: `돌파 매수 · 손절가 ${Math.round(sl).toLocaleString('ko-KR')} (돌파캔들 저가)` };
}

function stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null } {
  const entry = pos.entry_price;
  const ema20 = row.lines.ema20;
  // 1. 절대 손절 (거짓 돌파 실패)
  if (row.low <= pos.sl) {
    return { events: [{ side: 'SELL_SL', price: pos.sl, shares: pos.shares, pnl: pos.shares * (pos.sl - entry), note: '돌파 실패 손절', time: row.time }], updated: null };
  }
  // 2. 추세 추적 청산 (EMA20 하향 이탈)
  if (ema20 != null && row.close < ema20) {
    const profit = row.close > entry ? '익절' : '약손실';
    return { events: [{ side: 'SELL_TP2', price: row.close, shares: pos.shares, pnl: pos.shares * (row.close - entry), note: `추세 이탈 청산 (${profit})`, time: row.time }], updated: null };
  }
  return { events: [], updated: pos };
}

function scan(symbol: string, name: string, rows: StratRow[]): StratScan {
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const price = last?.close ?? 0;
  const changePct = prev ? ((last.close - prev.close) / prev.close) * 100 : 0;
  const highest = last?.m.highest ?? null;
  const ema20 = last?.m.ema20 ?? null;
  const volRatio = last?.m.volRatio ?? null;

  const isBreakout = highest != null && last.close > highest;
  const nearBreak = !isBreakout && highest != null && last.close >= highest * 0.98;
  const volSurge = volRatio != null && volRatio >= PARAMS.volMult;
  const volUp = volRatio != null && volRatio >= 1.5;
  const aboveEma = ema20 != null && last.close > ema20;

  const conditions = [
    { label: `60일 최고가 상향 돌파`, met: isBreakout, pts: 40 },
    { label: `거래량 ${PARAMS.volMult}배 이상 급증`, met: volSurge, pts: 30 },
    { label: '거래량 1.5배 이상', met: volUp, pts: 10 },
    { label: 'EMA20 위 (상승 추세)', met: aboveEma, pts: 15 },
    { label: '저항선 근접 (2% 이내)', met: isBreakout || nearBreak, pts: 5 },
  ];
  const score = conditions.reduce((a, c) => a + (c.met ? c.pts : 0), 0);

  return {
    symbol, name, price, changePct,
    buy: last?.buy ?? false,
    exit: last?.exit ?? false,
    score, stars: starsFromScore(score),
    cols: [
      { value: isBreakout ? '돌파' : nearBreak ? '근접' : '-', tone: isBreakout ? 'up' : 'muted' },
      { value: volRatio != null ? volRatio.toFixed(1) + '배' : '-', tone: volSurge ? 'accent' : 'default' },
      { value: aboveEma ? '상승' : '하락', tone: aboveEma ? 'up' : 'down' },
    ],
    conditions,
  };
}

export const breakout: StrategyModule = {
  code: 'breakout',
  name: '전략2 · 추세 돌파 + 거래량 급증',
  short: '일봉 기준 60일 최고가를 거래량 2.5배 급증과 함께 상향 돌파 시 매수. 돌파캔들 저가 손절, EMA20 이탈 시 추세 청산.',
  interval: '1d',
  range: '1y',
  positionPct: PARAMS.positionPct,
  params: PARAMS,
  lineStyles: [
    { key: 'high60', color: '#f59e0b', width: 2, label: '60일 저항선' },
    { key: 'ema20', color: '#22c55e', width: 1, label: 'EMA20 추세선' },
  ],
  colHeaders: ['돌파', '거래량배수', '추세'],
  rules: [
    { tag: '①', color: 'text-accent', title: '진입', body: '종가가 60일 최고가(저항선)를 상향 돌파하고, 거래량이 20일 평균의 2.5배 이상 급증할 때 가용 현금 20% 매수.' },
    { tag: '②', color: 'text-amber-400', title: '절대 손절', body: '돌파를 만든 캔들의 저가(Low)를 이탈하면 거짓 돌파로 간주하고 전량 손절.' },
    { tag: '③', color: 'text-profit', title: '추세 추적 청산', body: '목표가를 두지 않고 홀딩, 종가가 EMA20을 하향 이탈하면 전량 익절 청산 (Trailing Stop).' },
    { tag: '④', color: 'text-slate-300', title: '성과 기준', body: '승률보다 손익비(1:3 이상)에 집중. 거짓 돌파로 승률은 낮을 수 있음.' },
  ],
  compute, scan, planEntry, stepOpen,
};
