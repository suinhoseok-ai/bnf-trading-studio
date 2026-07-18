// ===== 전략8: (상승) 시가돌파 단타 [신규] =====
// 15분봉 근사 구현 (원 명세는 실시간 초단위 감시 전제 — 여기선 15분봉 단위로 근사한다).
// 전일 양봉·거래량 Z≥1.5 종목 중, 장 초반(당일 첫 6봉≈09:00~10:30) 시가+1% 상향 돌파 +
// 당일 누적 VWAP 위 + 돌파봉 거래량 Z≥2 + 시가 갭 -1%~+3% 시 매수. 당일 15:20 이후 강제 전량 청산(trader.mts).
import type { Candle } from '../types';
import type { StrategyModule, StratRow, OpenPos, ExitEvent, EntryPlan, StratScan } from './types';
import { calcShares, starsFromScore, vwapArr, volumeZScoreAt, dailyChangePct } from './engine';

const PARAMS = {
  entryWindowBars: 6, openBreakPct: 1, volZEntryMin: 2.0, prevDayVolZMin: 1.5,
  gapMin: -1, gapMax: 3, slOpenPct: 1.5, tp1: 2, tp2: 4, positionPct: 8,
};

interface DayGroup { startIdx: number; endIdx: number }

function groupByDay(candles: Candle[]): DayGroup[] {
  const dateStr = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const groups: DayGroup[] = [];
  let cur = '';
  for (let i = 0; i < candles.length; i++) {
    const d = dateStr(candles[i].time);
    if (d !== cur) { groups.push({ startIdx: i, endIdx: i }); cur = d; }
    else groups[groups.length - 1].endIdx = i;
  }
  return groups;
}

function compute(candles: Candle[]): StratRow[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const times = candles.map((c) => c.time);
  const vwap = vwapArr(times, highs, lows, closes, volumes);

  const days = groupByDay(candles);
  const dayOfIdx: number[] = new Array(candles.length).fill(0);
  const barInDay: number[] = new Array(candles.length).fill(0);
  days.forEach((g, d) => { for (let i = g.startIdx; i <= g.endIdx; i++) { dayOfIdx[i] = d; barInDay[i] = i - g.startIdx; } });
  const dayVolTotal = days.map((g) => volumes.slice(g.startIdx, g.endIdx + 1).reduce((a, b) => a + b, 0));
  const prevDayVolZ = (d: number): number | null => {
    if (d < 1) return null;
    const window = dayVolTotal.slice(Math.max(0, d - 21), d - 1); // d-1일(전일) 제외한 그 이전 최대 20일
    if (window.length < 5) return null;
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length);
    return sd === 0 ? 0 : (dayVolTotal[d - 1] - mean) / sd;
  };
  const prevDayBullish = (d: number): boolean => {
    if (d < 1) return false;
    const g = days[d - 1];
    return candles[g.endIdx].close > candles[g.startIdx].open;
  };

  return candles.map((c, i) => {
    const d = dayOfIdx[i];
    const g = days[d];
    const dayOpen = candles[g.startIdx].open;
    const prevClose = d > 0 ? candles[days[d - 1].endIdx].close : null;
    const gapPct = prevClose != null && prevClose > 0 ? ((dayOpen - prevClose) / prevClose) * 100 : null;

    const withinWindow = barInDay[i] <= PARAMS.entryWindowBars;
    const brokeOpen = dayOpen > 0 && c.close >= dayOpen * (1 + PARAMS.openBreakPct / 100);
    const aboveVwap = vwap[i] != null && c.close > (vwap[i] as number);
    const volZ = volumeZScoreAt(volumes, 20, i);
    const volOk = volZ != null && volZ >= PARAMS.volZEntryMin;
    const gapOk = gapPct == null || (gapPct >= PARAMS.gapMin && gapPct <= PARAMS.gapMax);
    const candidate = prevDayBullish(d) && (prevDayVolZ(d) ?? 0) >= PARAMS.prevDayVolZMin;

    const buy = !!(candidate && withinWindow && brokeOpen && aboveVwap && volOk && gapOk);
    const exit = vwap[i] != null && c.close < (vwap[i] as number);

    return {
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      buy, exit,
      lines: { vwap: vwap[i] },
      m: { dayOpen, gapPct, volZ, vwap: vwap[i], candidate: candidate ? 1 : 0, withinWindow: withinWindow ? 1 : 0 },
    };
  });
}

function planEntry(rows: StratRow[], i: number, cash: number): EntryPlan | null {
  const row = rows[i];
  const dayOpen = row.m.dayOpen as number | null;
  if (dayOpen == null) return null;
  const entry = row.close;
  const sl = Math.max(dayOpen * (1 - PARAMS.slOpenPct / 100), row.low);
  if (sl >= entry) return null;
  const shares = calcShares(cash, PARAMS.positionPct, entry);
  if (shares <= 0) return null;
  return { entry_price: entry, shares, sl, note: `시가돌파 단타 매수 · 손절가 ${Math.round(sl).toLocaleString('ko-KR')}` };
}

function stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null } {
  const events: ExitEvent[] = [];
  let { shares, tp1_hit } = pos;
  const entry = pos.entry_price;
  const vwap = row.lines.vwap;

  if (row.low <= pos.sl) {
    events.push({ side: 'SELL_SL', price: pos.sl, shares, pnl: shares * (pos.sl - entry), note: '손절 청산', time: row.time });
    return { events, updated: null };
  }
  const profitPct = ((row.close - entry) / entry) * 100;
  if (!tp1_hit && profitPct >= PARAMS.tp1) {
    const half = shares * 0.4;
    events.push({ side: 'SELL_TP1', price: row.close, shares: half, pnl: half * (row.close - entry), note: `+${PARAMS.tp1}% 40% 익절`, time: row.time });
    shares -= half;
    tp1_hit = true;
  }
  if (tp1_hit && profitPct >= PARAMS.tp2 && shares > 0) {
    const chunk = shares * (0.3 / 0.6);
    const sell = Math.min(shares, chunk);
    events.push({ side: 'SELL_TP1', price: row.close, shares: sell, pnl: sell * (row.close - entry), note: `+${PARAMS.tp2}% 추가 익절`, time: row.time });
    shares -= sell;
  }
  if (shares > 0 && vwap != null && row.close < vwap) {
    events.push({ side: 'SELL_TP2', price: row.close, shares, pnl: shares * (row.close - entry), note: 'VWAP 이탈 잔량 청산', time: row.time });
    return { events, updated: null };
  }
  // 당일 강제 청산(15:20 이후)은 trader.mts 매도 루프에서 시각 게이트로 별도 처리한다 (봉 데이터만으론 당일 여부 판단 불충분).
  if (shares <= 0) return { events, updated: null };
  return { events, updated: { ...pos, shares, tp1_hit } };
}

function scan(symbol: string, name: string, rows: StratRow[]): StratScan {
  const last = rows[rows.length - 1];
  const price = last?.close ?? 0;
  const changePct = dailyChangePct(rows);
  const candidate = last?.m.candidate === 1;
  const withinWindow = last?.m.withinWindow === 1;
  const gapPct = last?.m.gapPct ?? null;
  const gapOk = gapPct == null || (gapPct >= PARAMS.gapMin && gapPct <= PARAMS.gapMax);
  const volZ = last?.m.volZ ?? null;
  const volOk = volZ != null && volZ >= PARAMS.volZEntryMin;
  const vwap = last?.m.vwap ?? null;
  const aboveVwap = vwap != null && price > vwap;

  const conditions = [
    { label: `전일 양봉 & 거래량 Z≥${PARAMS.prevDayVolZMin}`, met: candidate, pts: 20 },
    { label: `장 초반(첫 ${PARAMS.entryWindowBars}봉) 시간대`, met: withinWindow, pts: 15 },
    { label: `시가 +${PARAMS.openBreakPct}% 상향 돌파`, met: last?.buy ?? false, pts: 25 },
    { label: '당일 누적 VWAP 위', met: aboveVwap, pts: 15 },
    { label: `돌파봉 거래량 Z≥${PARAMS.volZEntryMin}`, met: volOk, pts: 15 },
    { label: `시가 갭 ${PARAMS.gapMin}~${PARAMS.gapMax}%`, met: gapOk, pts: 10 },
  ];
  const score = conditions.reduce((a, c) => a + (c.met ? c.pts : 0), 0);

  return {
    symbol, name, price, changePct,
    buy: last?.buy ?? false,
    exit: last?.exit ?? false,
    score, stars: starsFromScore(score),
    cols: [
      { value: candidate ? '대상' : '-', tone: candidate ? 'accent' : 'muted' },
      { value: gapPct != null ? gapPct.toFixed(1) + '%' : '-', tone: gapOk ? 'default' : 'down' },
      { value: aboveVwap ? 'VWAP위' : 'VWAP아래', tone: aboveVwap ? 'up' : 'down' },
    ],
    conditions,
  };
}

export const openbrk: StrategyModule = {
  code: 'openbrk',
  name: '전략8 · (상승) 시가돌파 단타',
  short: '15분봉 근사: 전일 양봉·거래량 급증 종목이 장 초반 시가를 1% 상향 돌파하고 VWAP 위·거래량 급증 시 매수. +2%/+4% 분할익절 후 VWAP 이탈 잔량 청산, 15:20 이후 강제 전량 청산.',
  interval: '15m',
  range: '60d',
  positionPct: PARAMS.positionPct,
  params: PARAMS,
  regime: 'BULL', risk: 5,
  regimeFit: { BULL_MAJOR: 85, BULL: 75, RANGE: 10 },
  lineStyles: [
    { key: 'vwap', color: '#f59e0b', width: 2, label: 'VWAP (당일 누적)' },
  ],
  colHeaders: ['대상', '갭', 'VWAP'],
  rules: [
    { tag: '①', color: 'text-accent', title: '대상 선별', body: '전일 양봉 마감 + 전일 거래량 Z-score 1.5 이상인 종목만 후보로 삼는다.' },
    { tag: '②', color: 'text-accent', title: '진입', body: '장 초반(첫 6개 15분봉)에 종가가 당일 시가를 1% 상향 돌파 + 당일 누적 VWAP 위 + 돌파봉 거래량 Z-score 2 이상 + 시가 갭이 -1%~+3% 범위일 때 가용 현금 8% 매수. (15분봉 근사 구현 — 실시간 감시 아님)' },
    { tag: '③', color: 'text-amber-400', title: '손절', body: 'max(당일 시가 -1.5%, 진입봉 저가) 중 타이트한 값.' },
    { tag: '④', color: 'text-profit', title: '청산', body: '+2% 40%, +4% 추가 익절 후 잔여는 VWAP 이탈 시 청산. 장 마감 임박(15:20 이후)엔 자동매매 엔진이 잔여 물량을 무조건 시장가 전량 청산한다.' },
  ],
  compute, scan, planEntry, stepOpen,
};
