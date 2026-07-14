// ===== 전략5: 박스권 돌파 (Darvas Box Breakout) =====
// 조밀한 박스권(높이 15% 이내) 상단을 거래량 1.5배와 함께 돌파 시 매수. 박스 중간값 손절, EMA20 이탈 청산.
import type { Candle } from '../types';
import type { StrategyModule, StratRow, OpenPos, ExitEvent, EntryPlan, StratScan } from './types';
import { calcShares, starsFromScore, emaArr, maxOfPrev, minOfPrev, meanOfPrev, dailyChangePct } from './engine';

const PARAMS = { boxPeriod: 20, maxHeight: 15, volMult: 1.5, emaPeriod: 20, positionPct: 25 };

function compute(candles: Candle[]): StratRow[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const ema = emaArr(closes, PARAMS.emaPeriod);

  return candles.map((c, i) => {
    const boxTop = maxOfPrev(highs, PARAMS.boxPeriod, i);
    const boxBottom = minOfPrev(lows, PARAMS.boxPeriod, i);
    const boxHeight = boxTop != null && boxBottom != null && boxBottom !== 0 ? ((boxTop - boxBottom) / boxBottom) * 100 : null;
    const volMa = meanOfPrev(volumes, PARAMS.boxPeriod, i);
    const tightBox = boxHeight != null && boxHeight <= PARAMS.maxHeight;
    const isBreakout = boxTop != null && c.close > boxTop;
    const validVol = volMa != null && volMa > 0 && c.volume >= volMa * PARAMS.volMult;
    return {
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      buy: !!(tightBox && isBreakout && validVol),
      exit: c.close < ema[i], // EMA20 이탈 = 추세 종료 신호
      lines: { boxTop, boxBottom, ema20: ema[i] },
      m: { boxHeight, volRatio: volMa && volMa > 0 ? c.volume / volMa : null, ema20: ema[i], boxTop, boxBottom },
    };
  });
}

function planEntry(rows: StratRow[], i: number, cash: number): EntryPlan | null {
  const row = rows[i];
  const top = row.lines.boxTop, bottom = row.lines.boxBottom;
  if (top == null || bottom == null) return null;
  const entry = row.close;
  const sl = bottom + (top - bottom) / 2; // 박스 중간값 = 손절선
  const shares = calcShares(cash, PARAMS.positionPct, entry);
  if (shares <= 0) return null;
  return { entry_price: entry, shares, sl, note: `박스 돌파 매수 · 손절가 ${Math.round(sl).toLocaleString('ko-KR')} (박스 중간값)` };
}

function stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null } {
  const entry = pos.entry_price;
  const ema20 = row.lines.ema20;
  // 1. 박스 회귀 손절 (거짓 돌파 방어)
  if (row.close <= pos.sl) {
    return { events: [{ side: 'SELL_SL', price: row.close, shares: pos.shares, pnl: pos.shares * (row.close - entry), note: '거짓 돌파 손절 (박스 중간값 이탈)', time: row.time }], updated: null };
  }
  // 2. 추세 이탈 청산 (EMA20 하향 이탈)
  if (ema20 != null && row.close < ema20) {
    const profit = row.close > entry ? '익절' : '약손실';
    return { events: [{ side: 'SELL_TP2', price: row.close, shares: pos.shares, pnl: pos.shares * (row.close - entry), note: `추세 종료 청산 (${profit})`, time: row.time }], updated: null };
  }
  return { events: [], updated: pos };
}

function scan(symbol: string, name: string, rows: StratRow[]): StratScan {
  const last = rows[rows.length - 1];
  const price = last?.close ?? 0;
  const changePct = dailyChangePct(rows);
  const boxHeight = last?.m.boxHeight ?? null;
  const boxTop = last?.m.boxTop ?? null;
  const ema20 = last?.m.ema20 ?? null;
  const volRatio = last?.m.volRatio ?? null;

  const tightBox = boxHeight != null && boxHeight <= PARAMS.maxHeight;
  const isBreakout = boxTop != null && last.close > boxTop;
  const nearBreak = !isBreakout && boxTop != null && last.close >= boxTop * 0.98;
  const validVol = volRatio != null && volRatio >= PARAMS.volMult;
  const volUp = volRatio != null && volRatio >= 1.0;
  const aboveEma = ema20 != null && last.close > ema20;

  const conditions = [
    { label: `조밀한 박스권 (높이 ${PARAMS.maxHeight}% 이내)`, met: tightBox, pts: 25 },
    { label: '박스 상단 상향 돌파', met: isBreakout, pts: 35 },
    { label: `거래량 ${PARAMS.volMult}배 이상`, met: validVol, pts: 25 },
    { label: '거래량 평균 이상', met: volUp, pts: 10 },
    { label: 'EMA20 위', met: aboveEma, pts: 5 },
  ];
  const score = conditions.reduce((a, c) => a + (c.met ? c.pts : 0), 0);

  return {
    symbol, name, price, changePct,
    buy: last?.buy ?? false,
    exit: last?.exit ?? false,
    score, stars: starsFromScore(score),
    cols: [
      { value: boxHeight != null ? boxHeight.toFixed(1) + '%' : '-', tone: tightBox ? 'accent' : 'default' },
      { value: isBreakout ? '돌파' : nearBreak ? '근접' : '-', tone: isBreakout ? 'up' : 'muted' },
      { value: volRatio != null ? volRatio.toFixed(1) + '배' : '-', tone: validVol ? 'accent' : 'default' },
    ],
    conditions,
  };
}

export const box: StrategyModule = {
  code: 'box',
  name: '전략5 · 박스권 돌파',
  short: '일봉 기준 높이 15% 이내 조밀 박스권 상단을 거래량 1.5배와 함께 돌파 시 매수. 박스 중간값 손절, EMA20 이탈 청산.',
  interval: '1d',
  range: '1y',
  positionPct: PARAMS.positionPct,
  params: PARAMS,
  regime: 'SIDEWAYS', risk: 3,
  lineStyles: [
    { key: 'boxTop', color: '#22c55e', width: 2, label: '박스 상단' },
    { key: 'boxBottom', color: '#ef4444', width: 2, label: '박스 하단' },
    { key: 'ema20', color: '#f59e0b', width: 1, label: 'EMA20' },
  ],
  colHeaders: ['박스높이', '돌파', '거래량배수'],
  rules: [
    { tag: '①', color: 'text-accent', title: '진입', body: '직전 20일 박스 높이가 15% 이내로 응집된 상태에서 종가가 박스 상단을 돌파하고 거래량이 평균의 1.5배 이상일 때 가용 현금 25% 매수.' },
    { tag: '②', color: 'text-amber-400', title: '초기 손절', body: '돌파한 박스의 중간값(Mid-line)을 하향 이탈하면 거짓 돌파로 간주하고 전량 손절.' },
    { tag: '③', color: 'text-profit', title: '추세 추적 청산', body: '레벨업 후 종가가 EMA20을 하향 이탈하면 전량 익절 청산.' },
    { tag: '④', color: 'text-slate-300', title: '핵심', body: '단순 신고가가 아닌 “좁은 박스(변동성 수축)” 여부를 필터링하여 신뢰도를 높임.' },
  ],
  compute, scan, planEntry, stepOpen,
};
