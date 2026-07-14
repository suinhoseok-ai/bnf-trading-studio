// ===== 전략3: EMA 눌림목 모멘텀 (Swing Pullback) =====
// 정배열(EMA20>EMA60) 상승 추세에서 EMA20 눌림목 + 스토캐스틱 골든크로스 매수. 시간 청산(7영업일) 포함.
import type { Candle } from '../types';
import type { StrategyModule, StratRow, OpenPos, ExitEvent, EntryPlan, StratScan } from './types';
import { calcShares, starsFromScore, emaArr, smaAt, dailyChangePct } from './engine';

const PARAMS = { emaShort: 20, emaLong: 60, stochK: 14, stochSmooth: 3, maxDays: 7, positionPct: 20 };

function compute(candles: Candle[]): StratRow[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const ema20 = emaArr(closes, PARAMS.emaShort);
  const ema60 = emaArr(closes, PARAMS.emaLong);

  // 스토캐스틱 Fast %K → Slow %K(3) → Slow %D(3)
  const fastK: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < PARAMS.stochK - 1) { fastK.push(50); continue; }
    let ll = Infinity, hh = -Infinity;
    for (let j = i - PARAMS.stochK + 1; j <= i; j++) { ll = Math.min(ll, lows[j]); hh = Math.max(hh, highs[j]); }
    fastK.push(hh - ll === 0 ? 50 : ((closes[i] - ll) / (hh - ll)) * 100);
  }
  const slowK: (number | null)[] = fastK.map((_, i) => smaAt(fastK, PARAMS.stochSmooth, i));
  const slowD: (number | null)[] = slowK.map((_, i) => smaAt(slowK, PARAMS.stochSmooth, i));

  return candles.map((c, i) => {
    const volMa5 = smaAt(volumes, 5, i);
    const uptrend = ema20[i] > ema60[i];
    const pullbackZone = c.low <= ema20[i] * 1.02 && c.close > ema20[i];
    const k = slowK[i], d = slowD[i], pk = i > 0 ? slowK[i - 1] : null, pd = i > 0 ? slowD[i - 1] : null;
    const stochGC = k != null && d != null && pk != null && pd != null && k > d && pk <= pd;
    const momentumTurn = stochGC && d != null && d < 30;
    const lowVol = volMa5 != null && c.volume < volMa5;
    return {
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      buy: !!(uptrend && pullbackZone && momentumTurn && lowVol),
      exit: k != null && k >= 80, // 과매수 → 익절 신호
      lines: { ema20: ema20[i], ema60: ema60[i] },
      m: { slowK: k, slowD: d, ema20: ema20[i], ema60: ema60[i], volMa5 },
    };
  });
}

function planEntry(rows: StratRow[], i: number, cash: number): EntryPlan | null {
  const row = rows[i];
  const ema20 = row.lines.ema20;
  if (ema20 == null) return null;
  const entry = row.close;
  const sl = ema20 * 0.97; // EMA20 -3% 이탈 손절
  const shares = calcShares(cash, PARAMS.positionPct, entry);
  if (shares <= 0) return null;
  return { entry_price: entry, shares, sl, note: `눌림목 매수 · 손절가 ${Math.round(sl).toLocaleString('ko-KR')} (EMA20 -3%)` };
}

function stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null } {
  const entry = pos.entry_price;
  const k = row.m.slowK;
  // 1. 손절 — 명세서 기준 EMA20 대비 -3% "동적" 이탈 (지표 없으면 진입 시점 손절가 사용)
  const dynSl = row.lines.ema20 != null ? row.lines.ema20 * 0.97 : pos.sl;
  if (row.close <= dynSl) {
    return { events: [{ side: 'SELL_SL', price: row.close, shares: pos.shares, pnl: pos.shares * (row.close - entry), note: '추세 이탈 손절', time: row.time }], updated: null };
  }
  // 2. 모멘텀 익절 (스토캐스틱 과매수 80+)
  if (k != null && k >= 80) {
    return { events: [{ side: 'SELL_TP2', price: row.close, shares: pos.shares, pnl: pos.shares * (row.close - entry), note: '스토캐스틱 과매수 익절', time: row.time }], updated: null };
  }
  // 3. 시간 청산 (보유 7영업일 초과)
  const days = (row.time - Math.floor(new Date(pos.opened_at).getTime() / 1000)) / 86400;
  if (days >= PARAMS.maxDays) {
    return { events: [{ side: 'SELL_TP2', price: row.close, shares: pos.shares, pnl: pos.shares * (row.close - entry), note: '보유기간 만료 청산', time: row.time }], updated: null };
  }
  return { events: [], updated: pos };
}

function scan(symbol: string, name: string, rows: StratRow[]): StratScan {
  const last = rows[rows.length - 1];
  const price = last?.close ?? 0;
  const changePct = dailyChangePct(rows);
  const ema20 = last?.m.ema20 ?? null;
  const ema60 = last?.m.ema60 ?? null;
  const k = last?.m.slowK ?? null;
  const d = last?.m.slowD ?? null;
  const volMa5 = last?.m.volMa5 ?? null;

  const uptrend = ema20 != null && ema60 != null && ema20 > ema60;
  const pullbackZone = ema20 != null && last.low <= ema20 * 1.02 && last.close > ema20;
  const oversoldTurn = k != null && d != null && d < 30 && k > d;
  const lowVol = volMa5 != null && last.volume < volMa5;
  const notOverbought = k != null && k < 50;

  const conditions = [
    { label: '정배열 추세 (EMA20 > EMA60)', met: uptrend, pts: 25 },
    { label: '눌림목 도달 (EMA20 2% 이내)', met: pullbackZone, pts: 25 },
    { label: '스토캐스틱 침체권 반전', met: oversoldTurn, pts: 30 },
    { label: '조정 시 거래량 감소', met: lowVol, pts: 10 },
    { label: '과매수 아님 (%K < 50)', met: notOverbought, pts: 10 },
  ];
  const score = conditions.reduce((a, c) => a + (c.met ? c.pts : 0), 0);

  return {
    symbol, name, price, changePct,
    buy: last?.buy ?? false,
    exit: last?.exit ?? false,
    score, stars: starsFromScore(score),
    cols: [
      { value: uptrend ? '정배열' : '역배열', tone: uptrend ? 'up' : 'down' },
      { value: k != null ? k.toFixed(0) : '-', tone: k != null && k < 30 ? 'accent' : 'default' },
      { value: pullbackZone ? '근접' : '-', tone: pullbackZone ? 'up' : 'muted' },
    ],
    conditions,
  };
}

export const pullback: StrategyModule = {
  code: 'pullback',
  name: '전략3 · EMA 눌림목 모멘텀',
  short: '일봉 정배열(EMA20>EMA60) 추세에서 EMA20 눌림목 + 스토캐스틱 골든크로스 매수, 과매수/시간 청산.',
  interval: '1d',
  range: '1y',
  positionPct: PARAMS.positionPct,
  params: PARAMS,
  lineStyles: [
    { key: 'ema20', color: '#f59e0b', width: 2, label: 'EMA20' },
    { key: 'ema60', color: '#8b5cf6', width: 1, label: 'EMA60' },
  ],
  colHeaders: ['추세', '스토캐스틱K', '눌림목'],
  rules: [
    { tag: '①', color: 'text-accent', title: '진입', body: 'EMA20 > EMA60 정배열에서 저가가 EMA20 2% 이내로 눌리고, 스토캐스틱 %K가 30 이하에서 %D를 골든크로스, 거래량 감소 시 가용 현금 20% 매수.' },
    { tag: '②', color: 'text-amber-400', title: '손절', body: '종가가 EMA20 대비 -3%를 하향 이탈하면 전량 손절.' },
    { tag: '③', color: 'text-profit', title: '모멘텀 익절', body: '스토캐스틱 %K가 80 이상 과매수 진입 시 전량 익절.' },
    { tag: '④', color: 'text-slate-300', title: '시간 청산', body: '7영업일 경과 시 목표 미달이어도 기회비용 확보를 위해 청산.' },
  ],
  compute, scan, planEntry, stepOpen,
};
