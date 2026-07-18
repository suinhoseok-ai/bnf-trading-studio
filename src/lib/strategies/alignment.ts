// ===== 전략4: 이동평균선 정배열 추세 추종 (MA Alignment) =====
// 5>20>60>120 완전정배열 전환 초입 매수(이격도 필터). 20일선 이탈 50% 익절, 데드크로스/60일선 이탈 전량 청산.
import type { Candle } from '../types';
import type { StrategyModule, StratRow, OpenPos, ExitEvent, EntryPlan, StratScan } from './types';
import { calcShares, starsFromScore, smaAt, meanOfPrev, adxArr, dailyChangePct } from './engine';

const PARAMS = { ma1: 5, ma2: 20, ma3: 60, ma4: 120, disparityLimit: 108, adxMin: 20, entryWindowBars: 3, positionPct: 30 };

function compute(candles: Candle[]): StratRow[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const ma5: (number | null)[] = closes.map((_, i) => smaAt(closes, PARAMS.ma1, i));
  const ma20: (number | null)[] = closes.map((_, i) => smaAt(closes, PARAMS.ma2, i));
  const ma60: (number | null)[] = closes.map((_, i) => smaAt(closes, PARAMS.ma3, i));
  const ma120: (number | null)[] = closes.map((_, i) => smaAt(closes, PARAMS.ma4, i));
  const { adx } = adxArr(highs, lows, closes, 14);

  const aligned = closes.map((_, i) =>
    ma5[i] != null && ma20[i] != null && ma60[i] != null && ma120[i] != null &&
    (ma5[i] as number) > (ma20[i] as number) && (ma20[i] as number) > (ma60[i] as number) && (ma60[i] as number) > (ma120[i] as number),
  );
  // 정배열이 처음 완성된 시점부터 경과 봉수 (초입 진입 한정용)
  const barsSinceAligned: number[] = [];
  let streak = -1;
  for (let i = 0; i < aligned.length; i++) {
    streak = aligned[i] ? streak + 1 : -1;
    barsSinceAligned.push(streak);
  }

  return candles.map((c, i) => {
    const disparity = ma20[i] != null && (ma20[i] as number) !== 0 ? (c.close / (ma20[i] as number)) * 100 : null;
    const withinEntryWindow = barsSinceAligned[i] >= 0 && barsSinceAligned[i] <= PARAMS.entryWindowBars;
    const disparityOk = disparity != null && disparity <= PARAMS.disparityLimit;
    const adxOk = adx[i] != null && (adx[i] as number) >= PARAMS.adxMin;
    const volAvg20 = meanOfPrev(volumes, 20, i);
    const volOk = volAvg20 != null && volAvg20 > 0 && c.volume >= volAvg20;
    const buy = !!(withinEntryWindow && disparityOk && adxOk && volOk);
    const deadCross = ma5[i] != null && ma20[i] != null && (ma5[i] as number) < (ma20[i] as number);
    const below60 = ma60[i] != null && c.close < (ma60[i] as number);
    return {
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      buy,
      exit: deadCross || below60, // 데드크로스 또는 60일선 이탈 = 추세 종료 신호
      lines: { ma5: ma5[i], ma20: ma20[i], ma60: ma60[i], ma120: ma120[i] },
      m: {
        disparity, ma5: ma5[i], ma20: ma20[i], ma60: ma60[i], ma120: ma120[i],
        aligned: aligned[i] ? 1 : 0, adx: adx[i], volRatio: volAvg20 && volAvg20 > 0 ? c.volume / volAvg20 : null,
      },
    };
  });
}

function planEntry(rows: StratRow[], i: number, cash: number): EntryPlan | null {
  const row = rows[i];
  const ma120 = row.lines.ma120;
  if (ma120 == null) return null;
  const entry = row.close;
  const sl = ma120 * 0.98; // 120일선 -2% 이탈 손절
  const shares = calcShares(cash, PARAMS.positionPct, entry);
  if (shares <= 0) return null;
  return { entry_price: entry, shares, sl, note: `정배열 초입 매수 · 손절가 ${Math.round(sl).toLocaleString('ko-KR')} (120일선 -2%)` };
}

function stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null } {
  const events: ExitEvent[] = [];
  let { shares, tp1_hit } = pos;
  const entry = pos.entry_price;
  const ma5 = row.lines.ma5, ma20 = row.lines.ma20, ma60 = row.lines.ma60;

  // 1. 초기 손절 (120일선 지지 실패)
  if (row.close <= pos.sl) {
    events.push({ side: 'SELL_SL', price: row.close, shares, pnl: shares * (row.close - entry), note: '리스크 손절 (120일선 이탈)', time: row.time });
    return { events, updated: null };
  }
  // 2. 1차 분할 익절 (20일선 하향 이탈 → 50%)
  if (!tp1_hit && ma20 != null && row.close < ma20) {
    const half = shares * 0.5;
    events.push({ side: 'SELL_TP1', price: row.close, shares: half, pnl: half * (row.close - entry), note: '20일선 이탈 50% 분할 익절', time: row.time });
    shares -= half;
    tp1_hit = true;
  }
  // 3. 최종 청산 (데드크로스 또는 60일선 이탈 → 잔여 전량, TP1 선행 여부 무관)
  const deadCross = ma5 != null && ma20 != null && ma5 < ma20;
  const below60 = ma60 != null && row.close < ma60;
  if (deadCross || below60) {
    events.push({ side: 'SELL_TP2', price: row.close, shares, pnl: shares * (row.close - entry), note: '추세 종료 전량 청산', time: row.time });
    return { events, updated: null };
  }
  return { events, updated: { ...pos, shares, tp1_hit } };
}

function scan(symbol: string, name: string, rows: StratRow[]): StratScan {
  const last = rows[rows.length - 1];
  const price = last?.close ?? 0;
  const changePct = dailyChangePct(rows);
  const disparity = last?.m.disparity ?? null;
  const ma5 = last?.m.ma5 ?? null, ma20 = last?.m.ma20 ?? null, ma60 = last?.m.ma60 ?? null, ma120 = last?.m.ma120 ?? null;

  const aligned = last?.m.aligned === 1;
  const disparityOk = disparity != null && disparity <= PARAMS.disparityLimit;
  const shortUp = ma5 != null && ma20 != null && ma5 > ma20;
  const midUp = ma20 != null && ma60 != null && ma20 > ma60;
  const longUp = ma60 != null && ma120 != null && ma60 > ma120;
  const adx = last?.m.adx ?? null;
  const adxOk = adx != null && adx >= PARAMS.adxMin;
  const volRatio = last?.m.volRatio ?? null;
  const volOk = volRatio != null && volRatio >= 1;

  const conditions = [
    { label: '완전 정배열 (5>20>60>120)', met: aligned, pts: 25 },
    { label: `정배열 전환 초입 (${PARAMS.entryWindowBars}봉 이내)`, met: last?.buy ?? false, pts: 20 },
    { label: '이격도 108 이하 (과열 아님)', met: disparityOk, pts: 15 },
    { label: `ADX ${PARAMS.adxMin} 이상 (추세 강도)`, met: adxOk, pts: 15 },
    { label: '거래량 20일 평균 이상', met: volOk, pts: 10 },
    { label: '단기 상승 (MA5 > MA20)', met: shortUp, pts: 15 },
  ];
  void midUp; void longUp;
  const score = conditions.reduce((a, c) => a + (c.met ? c.pts : 0), 0);

  return {
    symbol, name, price, changePct,
    buy: last?.buy ?? false,
    exit: last?.exit ?? false,
    score, stars: starsFromScore(score),
    cols: [
      { value: aligned ? '완성' : '-', tone: aligned ? 'up' : 'muted' },
      { value: disparity != null ? disparity.toFixed(1) : '-', tone: disparityOk ? 'default' : 'down' },
      { value: shortUp ? '상승' : '하락', tone: shortUp ? 'up' : 'down' },
    ],
    conditions,
  };
}

export const alignment: StrategyModule = {
  code: 'alignment',
  name: '전략4 · 이동평균선 정배열',
  short: '일봉 5>20>60>120 완전 정배열 완성 후 3봉 이내 초입 매수(이격도·ADX·거래량 필터). 20일선 이탈 50% 익절, 데드크로스/60일선 이탈 전량 청산.',
  interval: '1d',
  range: '2y',
  positionPct: PARAMS.positionPct,
  params: PARAMS,
  regime: 'BULL', risk: 2,
  regimeFit: { BULL_MAJOR: 90, BULL: 95, RANGE: 20 },
  lineStyles: [
    { key: 'ma5', color: '#ef4444', width: 1, label: 'MA5' },
    { key: 'ma20', color: '#f59e0b', width: 1, label: 'MA20' },
    { key: 'ma60', color: '#22c55e', width: 1, label: 'MA60' },
    { key: 'ma120', color: '#8b5cf6', width: 2, label: 'MA120' },
  ],
  colHeaders: ['정배열', '이격도', '단기추세'],
  rules: [
    { tag: '①', color: 'text-accent', title: '진입', body: '5>20>60>120 완전 정배열 완성 후 3봉 이내(초입 한정) · 20일선 이격도 108 이하 · ADX 20 이상 · 거래량 20일 평균 이상일 때 가용 현금 30% 매수.' },
    { tag: '②', color: 'text-amber-400', title: '초기 손절', body: '진입 후 120일 이동평균선 하단 -2% 이탈 시 전량 손절.' },
    { tag: '③', color: 'text-profit', title: '1차 청산', body: '20일 이동평균선을 종가 하향 이탈 시 50% 분할 익절.' },
    { tag: '④', color: 'text-profit', title: '최종 청산', body: '5일선이 20일선을 데드크로스하거나 60일선을 이탈하면 잔여 전량 청산.' },
  ],
  compute, scan, planEntry, stepOpen,
};
