// ===== 전략3: (상승) 눌림목 스윙 (Pullback Swing) =====
// 정배열(MA5>MA20>MA60) 추세에서 20일 고점 대비 -3~-8% 건강한 조정(거래량 감소) 후
// 거래량 급증 반등캔들 + RSI 45~65 + MACD 히스토그램 개선 시 매수.
import type { Candle } from '../types';
import type { StrategyModule, StratRow, OpenPos, ExitEvent, EntryPlan, StratScan } from './types';
import { calcShares, starsFromScore, smaAt, meanOfPrev, atrArr, rsiSimple, macdArr, detectCandle, daysElapsed, dailyChangePct } from './engine';

const PARAMS = {
  ma1: 5, ma2: 20, ma3: 60, pullbackMin: 3, pullbackMax: 8,
  volDryRatio: 0.7, volSurgeRatio: 1.5, rsiLo: 45, rsiHi: 65,
  slPct: 4, atrMult: 1.5, tp1: 5, tp2: 8, maxDays: 7, minReturnByMaxDays: 3, positionPct: 20,
};

function compute(candles: Candle[]): StratRow[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const ma5 = closes.map((_, i) => smaAt(closes, PARAMS.ma1, i));
  const ma10 = closes.map((_, i) => smaAt(closes, 10, i));
  const ma20 = closes.map((_, i) => smaAt(closes, PARAMS.ma2, i));
  const ma60 = closes.map((_, i) => smaAt(closes, PARAMS.ma3, i));
  const rsi = rsiSimple(closes, 14);
  const { hist } = macdArr(closes);
  const atr = atrArr(highs, lows, closes, 14);

  return candles.map((c, i) => {
    const aligned = ma5[i] != null && ma20[i] != null && ma60[i] != null &&
      (ma5[i] as number) > (ma20[i] as number) && (ma20[i] as number) > (ma60[i] as number);

    const high20 = i >= 19 ? Math.max(...highs.slice(Math.max(0, i - 19), i + 1)) : null;
    const pullbackPct = high20 != null && high20 > 0 ? ((high20 - c.close) / high20) * 100 : null;
    const inPullbackRange = pullbackPct != null && pullbackPct >= PARAMS.pullbackMin && pullbackPct <= PARAMS.pullbackMax;
    const inMaBand = ma10[i] != null && ma20[i] != null &&
      c.close <= Math.max(ma10[i] as number, ma20[i] as number) * 1.01 && c.close >= Math.min(ma10[i] as number, ma20[i] as number) * 0.99;

    const volAvg5 = meanOfPrev(volumes, 5, i);
    const volAvg20 = meanOfPrev(volumes, 20, i);
    const dryUp = volAvg5 != null && volAvg20 != null && volAvg20 > 0 && volAvg5 <= volAvg20 * PARAMS.volDryRatio;
    const volSurge = volAvg20 != null && volAvg20 > 0 && c.volume >= volAvg20 * PARAMS.volSurgeRatio;

    const prev = i > 0 ? candles[i - 1] : undefined;
    const pattern = detectCandle(c, prev);
    const reboundCandle = (pattern.bigBull || pattern.hammer || pattern.bullishEngulfing) && (prev ? c.close > prev.high : false);

    const rsiOk = rsi[i] != null && (rsi[i] as number) >= PARAMS.rsiLo && (rsi[i] as number) <= PARAMS.rsiHi;
    const macdImproving = i > 0 && hist[i] > hist[i - 1];

    const buy = !!(aligned && inPullbackRange && inMaBand && dryUp && volSurge && reboundCandle && rsiOk && macdImproving);
    const exit = ma5[i] != null && c.close < (ma5[i] as number);

    return {
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      buy, exit,
      lines: { ma5: ma5[i], ma10: ma10[i], ma20: ma20[i], ma60: ma60[i] },
      m: { aligned: aligned ? 1 : 0, pullbackPct, dryUp: dryUp ? 1 : 0, volSurge: volSurge ? 1 : 0, rsi: rsi[i], macdHist: hist[i], atr: atr[i], ma5: ma5[i] },
    };
  });
}

function planEntry(rows: StratRow[], i: number, cash: number): EntryPlan | null {
  const row = rows[i];
  const ma20 = row.lines.ma20;
  if (ma20 == null) return null;
  const entry = row.close;
  const atrNow = (row.m.atr as number | null) ?? null;
  const candidates = [entry * (1 - PARAMS.slPct / 100), ma20, atrNow != null ? entry - atrNow * PARAMS.atrMult : entry * (1 - PARAMS.slPct / 100)];
  const sl = Math.max(...candidates);
  if (sl >= entry) return null;
  const shares = calcShares(cash, PARAMS.positionPct, entry);
  if (shares <= 0) return null;
  return { entry_price: entry, shares, sl, note: `눌림목 반등 매수 · 손절가 ${Math.round(sl).toLocaleString('ko-KR')}` };
}

function stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null } {
  const events: ExitEvent[] = [];
  let { shares, tp1_hit } = pos;
  const entry = pos.entry_price;
  const ma5 = row.lines.ma5;

  if (row.close <= pos.sl) {
    events.push({ side: 'SELL_SL', price: row.close, shares, pnl: shares * (row.close - entry), note: '손절 청산', time: row.time });
    return { events, updated: null };
  }
  const profitPct = ((row.close - entry) / entry) * 100;
  if (!tp1_hit && profitPct >= PARAMS.tp1) {
    const half = shares * 0.3;
    events.push({ side: 'SELL_TP1', price: row.close, shares: half, pnl: half * (row.close - entry), note: `+${PARAMS.tp1}% 30% 익절`, time: row.time });
    shares -= half;
    tp1_hit = true;
  }
  if (tp1_hit && profitPct >= PARAMS.tp2 && shares > 0) {
    const chunk = shares * (0.3 / 0.7); // 원 물량의 30%p 추가 (잔여의 비례)
    const sell = Math.min(shares, chunk);
    events.push({ side: 'SELL_TP1', price: row.close, shares: sell, pnl: sell * (row.close - entry), note: `+${PARAMS.tp2}% 추가 익절`, time: row.time });
    shares -= sell;
  }
  if (shares > 0 && ma5 != null && row.close < ma5) {
    events.push({ side: 'SELL_TP2', price: row.close, shares, pnl: shares * (row.close - entry), note: 'MA5 이탈 잔량 청산', time: row.time });
    return { events, updated: null };
  }
  const days = daysElapsed(row.time, pos.opened_at);
  if (shares > 0 && days >= PARAMS.maxDays && profitPct < PARAMS.minReturnByMaxDays) {
    events.push({ side: 'SELL_TP2', price: row.close, shares, pnl: shares * (row.close - entry), note: '보유기간 만료 청산', time: row.time });
    return { events, updated: null };
  }
  if (shares <= 0) return { events, updated: null };
  return { events, updated: { ...pos, shares, tp1_hit } };
}

function scan(symbol: string, name: string, rows: StratRow[]): StratScan {
  const last = rows[rows.length - 1];
  const price = last?.close ?? 0;
  const changePct = dailyChangePct(rows);
  const aligned = last?.m.aligned === 1;
  const pullbackPct = last?.m.pullbackPct ?? null;
  const inRange = pullbackPct != null && pullbackPct >= PARAMS.pullbackMin && pullbackPct <= PARAMS.pullbackMax;
  const dryUp = last?.m.dryUp === 1;
  const volSurge = last?.m.volSurge === 1;
  const rsi = last?.m.rsi ?? null;
  const rsiOk = rsi != null && rsi >= PARAMS.rsiLo && rsi <= PARAMS.rsiHi;

  const conditions = [
    { label: '정배열 (MA5>MA20>MA60)', met: aligned, pts: 20 },
    { label: `20일 고점 대비 ${PARAMS.pullbackMin}~${PARAMS.pullbackMax}% 조정`, met: inRange, pts: 20 },
    { label: '조정기 거래량 감소 (건강한 눌림)', met: dryUp, pts: 20 },
    { label: '반등일 거래량 급증', met: volSurge, pts: 15 },
    { label: `RSI ${PARAMS.rsiLo}~${PARAMS.rsiHi}`, met: rsiOk, pts: 15 },
    { label: '반등 신호 (매수)', met: last?.buy ?? false, pts: 10 },
  ];
  const score = conditions.reduce((a, c) => a + (c.met ? c.pts : 0), 0);

  return {
    symbol, name, price, changePct,
    buy: last?.buy ?? false,
    exit: last?.exit ?? false,
    score, stars: starsFromScore(score),
    cols: [
      { value: aligned ? '정배열' : '역배열', tone: aligned ? 'up' : 'down' },
      { value: pullbackPct != null ? pullbackPct.toFixed(1) + '%' : '-', tone: inRange ? 'accent' : 'default' },
      { value: rsi != null ? rsi.toFixed(0) : '-', tone: rsiOk ? 'up' : 'muted' },
    ],
    conditions,
  };
}

export const pullback: StrategyModule = {
  code: 'pullback',
  name: '전략3 · (상승) 눌림목 스윙',
  short: '일봉 정배열(MA5>MA20>MA60)에서 20일 고점 대비 3~8% 건강한 조정(거래량 감소) 후 거래량 급증 반등캔들 + RSI 45~65 + MACD 개선 시 매수. 분할익절(+5%/+8%) 후 MA5 이탈 잔량 청산, 7일 시간청산.',
  interval: '1d',
  range: '1y',
  positionPct: PARAMS.positionPct,
  params: PARAMS,
  regime: 'BULL', risk: 2,
  regimeFit: { BULL_MAJOR: 80, BULL: 100, RANGE: 25 },
  lineStyles: [
    { key: 'ma5', color: '#ef4444', width: 1, label: 'MA5' },
    { key: 'ma10', color: '#f59e0b', width: 1, label: 'MA10' },
    { key: 'ma20', color: '#22c55e', width: 2, label: 'MA20' },
    { key: 'ma60', color: '#8b5cf6', width: 1, label: 'MA60' },
  ],
  colHeaders: ['추세', '조정폭', 'RSI'],
  rules: [
    { tag: '①', color: 'text-accent', title: '진입', body: '정배열(MA5>MA20>MA60)에서 20일 고점 대비 3~8% 눌림(MA10~MA20 밴드 내) + 조정기 거래량 감소 + 반등일 거래량 급증 + 반등캔들 + RSI 45~65 + MACD 히스토그램 개선 시 가용 현금 20% 매수.' },
    { tag: '②', color: 'text-amber-400', title: '손절', body: 'max(진입가 -4%, MA20 종가 이탈, 진입가 -ATR×1.5) 중 가장 타이트한 값.' },
    { tag: '③', color: 'text-profit', title: '분할 익절', body: '+5% 도달 시 30%, +8% 도달 시 추가 익절. 잔여는 MA5 종가 이탈 시 전량 청산.' },
    { tag: '④', color: 'text-slate-300', title: '시간 청산', body: '7거래일 경과 시 수익률이 3% 미만이면 잔여 물량 강제 청산.' },
  ],
  compute, scan, planEntry, stepOpen,
};
