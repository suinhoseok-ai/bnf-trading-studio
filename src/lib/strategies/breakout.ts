// ===== 전략2: (상승) 추세추종 · 신고가 돌파 (Trend Follow Breakout) =====
// 정배열 + 60일(또는 ADX≥30 시 20일) 신고가 돌파 + 거래량 Z≥2 + 짧은 윗꼬리 + RS(KOSPI 대비 강세) + OBV 상승.
// 초기 손절 max(-6%, 돌파봉 저가, 진입가-ATR×2). +8% 도달 후 10일선 이탈 50%, 잔여 ATR×3 트레일/60일선 전량.
import type { Candle } from '../types';
import type { StrategyModule, StratRow, OpenPos, ExitEvent, EntryPlan, StratScan, CandleFetcher } from './types';
import {
  calcShares, starsFromScore, smaAt, emaArr, maxOfPrev, adxArr, atrArr, obvArr,
  volumeZScoreAt, atrTrailSl, dailyChangePct,
} from './engine';

const PARAMS = {
  ma1: 20, ma2: 60, ma3: 120, resLong: 60, resShort: 20, adxShortMin: 30,
  volZMin: 2.0, wickMaxRatio: 0.3, obvLookback: 20, retLookback: 20,
  trail1: 10, trail2: 60, atrMult: 2, atrTrailMult: 3, tp1Profit: 8, positionPct: 20,
};
const INDEX_SYMBOL = '^KS11';
const INDEX_TTL = 10 * 60_000;

let indexBars: { time: number; ret20: number | null }[] = [];
let indexLoadedAt = 0;

async function init(fetch: CandleFetcher): Promise<void> {
  if (indexBars.length > 0 && Date.now() - indexLoadedAt < INDEX_TTL) return;
  try {
    const candles = await fetch(INDEX_SYMBOL, '1d', '1y');
    const closes = candles.map((c) => c.close);
    indexBars = candles.map((c, i) => ({
      time: c.time,
      ret20: i >= PARAMS.retLookback && closes[i - PARAMS.retLookback] > 0
        ? ((closes[i] - closes[i - PARAMS.retLookback]) / closes[i - PARAMS.retLookback]) * 100 : null,
    }));
    indexLoadedAt = Date.now();
  } catch { /* 실패 시 기존 캐시 유지 (없으면 RS 필터 통과 처리) */ }
}

function kospiRet20At(time: number): number | null {
  if (indexBars.length === 0) return null;
  let lo = 0, hi = indexBars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (indexBars[mid].time <= time + 43_200) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans < 0 ? null : indexBars[ans].ret20;
}

function compute(candles: Candle[]): StratRow[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const ma20 = closes.map((_, i) => smaAt(closes, PARAMS.ma1, i));
  const ma60 = closes.map((_, i) => smaAt(closes, PARAMS.ma2, i));
  const ma120 = closes.map((_, i) => smaAt(closes, PARAMS.ma3, i));
  const ma10 = closes.map((_, i) => smaAt(closes, PARAMS.trail1, i));
  const { adx } = adxArr(highs, lows, closes, 14);
  const atr = atrArr(highs, lows, closes, 14);
  const obv = obvArr(closes, volumes);

  return candles.map((c, i) => {
    const aligned = ma20[i] != null && ma60[i] != null && ma120[i] != null &&
      (ma20[i] as number) > (ma60[i] as number) && (ma60[i] as number) > (ma120[i] as number);
    const above20 = ma20[i] != null && c.close > (ma20[i] as number);

    const high60 = maxOfPrev(highs, PARAMS.resLong, i);
    const high20 = maxOfPrev(highs, PARAMS.resShort, i);
    const breakLong = high60 != null && c.close > high60;
    const breakShort = high20 != null && c.close > high20 && adx[i] != null && (adx[i] as number) >= PARAMS.adxShortMin;
    const isBreakout = breakLong || breakShort;

    const volZ = volumeZScoreAt(volumes, 20, i);
    const volOk = volZ != null && volZ >= PARAMS.volZMin;

    const range = c.high - c.low;
    const upperWick = c.high - Math.max(c.open, c.close);
    const wickOk = range <= 0 || upperWick / range <= PARAMS.wickMaxRatio;

    const obvOk = i >= PARAMS.obvLookback && obv[i] - obv[i - PARAMS.obvLookback] > 0;

    const stockRet20 = i >= PARAMS.retLookback && closes[i - PARAMS.retLookback] > 0
      ? ((c.close - closes[i - PARAMS.retLookback]) / closes[i - PARAMS.retLookback]) * 100 : null;
    const kospiRet = kospiRet20At(c.time);
    const rsOk = stockRet20 != null && (kospiRet == null || stockRet20 > kospiRet);

    const buy = !!(aligned && above20 && isBreakout && volOk && wickOk && obvOk && rsOk);
    const exit = ma10[i] != null && c.close < (ma10[i] as number);

    return {
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      buy, exit,
      lines: { high60, ma10: ma10[i], ma20: ma20[i], ma60: ma60[i] },
      m: {
        aligned: aligned ? 1 : 0, high60, volZ, wickOk: wickOk ? 1 : 0, obvOk: obvOk ? 1 : 0,
        stockRet20, kospiRet, atr: atr[i], ma10: ma10[i], ma60: ma60[i],
      },
    };
  });
}

function planEntry(rows: StratRow[], i: number, cash: number): EntryPlan | null {
  const row = rows[i];
  const entry = row.close;
  const atrNow = (row.m.atr as number | null) ?? null;
  const candidates = [entry * 0.94, row.low, atrNow != null ? entry - atrNow * PARAMS.atrMult : entry * 0.94];
  const sl = Math.max(...candidates);
  if (sl >= entry) return null;
  const shares = calcShares(cash, PARAMS.positionPct, entry);
  if (shares <= 0) return null;
  return { entry_price: entry, shares, sl, note: `추세추종 돌파 매수 · 손절가 ${Math.round(sl).toLocaleString('ko-KR')}` };
}

function stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null } {
  const events: ExitEvent[] = [];
  let { shares, sl, tp1_hit } = pos;
  const entry = pos.entry_price;
  const ma10 = row.lines.ma10, ma60 = row.lines.ma60;
  const atrNow = (row.m.atr as number | null) ?? null;

  if (row.low <= sl) {
    events.push({ side: 'SELL_SL', price: sl, shares, pnl: shares * (sl - entry), note: '손절 청산', time: row.time });
    return { events, updated: null };
  }

  const profitPct = ((row.close - entry) / entry) * 100;
  if (!tp1_hit && profitPct >= PARAMS.tp1Profit && ma10 != null && row.close < ma10) {
    const half = shares * 0.5;
    events.push({ side: 'SELL_TP1', price: row.close, shares: half, pnl: half * (row.close - entry), note: `10일선 이탈 50% 익절 (+${PARAMS.tp1Profit}% 도달 후)`, time: row.time });
    shares -= half;
    tp1_hit = true;
    sl = Math.max(sl, entry); // 잔여분 본절 이상 확보
  }

  if (tp1_hit && atrNow != null) sl = atrTrailSl(sl, row.high, atrNow, PARAMS.atrTrailMult);

  if (tp1_hit && ma60 != null && row.close < ma60) {
    events.push({ side: 'SELL_TP2', price: row.close, shares, pnl: shares * (row.close - entry), note: '60일선 이탈 전량 청산', time: row.time });
    return { events, updated: null };
  }
  if (tp1_hit && row.close <= sl) {
    events.push({ side: 'SELL_TP2', price: sl, shares, pnl: shares * (sl - entry), note: 'ATR 트레일링 스탑 청산', time: row.time });
    return { events, updated: null };
  }

  return { events, updated: { ...pos, shares, sl, tp1_hit } };
}

function scan(symbol: string, name: string, rows: StratRow[]): StratScan {
  const last = rows[rows.length - 1];
  const price = last?.close ?? 0;
  const changePct = dailyChangePct(rows);
  const aligned = last?.m.aligned === 1;
  const high60 = last?.m.high60 ?? null;
  const isBreakout = high60 != null && last.close > high60;
  const volZ = last?.m.volZ ?? null;
  const volOk = volZ != null && volZ >= PARAMS.volZMin;
  const wickOk = last?.m.wickOk === 1;
  const obvOk = last?.m.obvOk === 1;
  const stockRet20 = last?.m.stockRet20 ?? null;
  const kospiRet = last?.m.kospiRet ?? null;
  const rsOk = stockRet20 != null && (kospiRet == null || stockRet20 > kospiRet);

  const conditions = [
    { label: '정배열 (MA20>MA60>MA120)', met: aligned, pts: 15 },
    { label: '60일 신고가 돌파 (또는 20일+ADX30)', met: isBreakout, pts: 25 },
    { label: '거래량 Z-score ≥ 2', met: volOk, pts: 20 },
    { label: '짧은 윗꼬리 (돌파 신뢰도)', met: wickOk, pts: 10 },
    { label: 'KOSPI 대비 상대강도(RS) 우위', met: rsOk, pts: 20 },
    { label: 'OBV 20일 상승', met: obvOk, pts: 10 },
  ];
  const score = conditions.reduce((a, c) => a + (c.met ? c.pts : 0), 0);

  return {
    symbol, name, price, changePct,
    buy: last?.buy ?? false,
    exit: last?.exit ?? false,
    score, stars: starsFromScore(score),
    cols: [
      { value: isBreakout ? '돌파' : '-', tone: isBreakout ? 'up' : 'muted' },
      { value: volZ != null ? volZ.toFixed(1) + 'σ' : '-', tone: volOk ? 'accent' : 'default' },
      { value: rsOk ? 'RS우위' : '열위', tone: rsOk ? 'up' : 'down' },
    ],
    conditions,
  };
}

export const breakout: StrategyModule = {
  code: 'breakout',
  name: '전략2 · (상승) 추세추종 · 신고가 돌파',
  short: '일봉 정배열 상태에서 60일(또는 ADX≥30 시 20일) 신고가를 거래량 Z≥2·짧은 윗꼬리·RS우위·OBV상승과 함께 돌파 시 매수. +8% 도달 후 10일선 이탈 50% 익절, 잔여 ATR 트레일/60일선 이탈 전량 청산.',
  interval: '1d',
  range: '1y',
  positionPct: PARAMS.positionPct,
  params: PARAMS,
  regime: 'BULL', risk: 3,
  regimeFit: { BULL_MAJOR: 100, BULL: 85, RANGE: 15 },
  lineStyles: [
    { key: 'high60', color: '#f59e0b', width: 2, label: '60일 저항선' },
    { key: 'ma10', color: '#22c55e', width: 1, label: 'MA10 (1차 트레일)' },
    { key: 'ma60', color: '#8b5cf6', width: 1, label: 'MA60 (최종 트레일)' },
  ],
  colHeaders: ['돌파', '거래량Z', 'RS'],
  rules: [
    { tag: '①', color: 'text-accent', title: '진입', body: '정배열(MA20>MA60>MA120) 상태에서 60일 신고가(또는 ADX≥30 시 20일 신고가)를 거래량 Z-score 2 이상·짧은 윗꼬리·KOSPI 대비 상대강도 우위·OBV 20일 상승과 함께 돌파 시 가용 현금 20% 매수.' },
    { tag: '②', color: 'text-amber-400', title: '초기 손절', body: 'max(진입가 -6%, 돌파봉 저가, 진입가 -ATR×2) 중 가장 타이트한 값을 손절가로 설정.' },
    { tag: '③', color: 'text-profit', title: '1차 청산', body: '수익 +8% 도달 후 10일선을 종가 하향 이탈하면 50% 익절, 잔여분 손절가를 본절 이상으로 이동.' },
    { tag: '④', color: 'text-profit', title: '최종 청산', body: '잔여 50%는 ATR×3 트레일링 스탑 또는 60일선 이탈 시 전량 청산.' },
  ],
  init, compute, scan, planEntry, stepOpen,
};
