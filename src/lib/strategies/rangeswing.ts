// ===== 전략9: (횡보) 박스권 스윙 [신규 — 박스권 역추세/스윙 md 2건 통합] =====
// 최근 25일 박스(폭 6~18%, 하단/상단 각 2회 이상 터치, 삼각수렴 제외) 하단 근접 + 조정기 거래량 감소 +
// 반등캔들 + RSI 30~50 + Slow Stoch 골든크로스 + CCI -100 회복 시 매수.
import type { Candle } from '../types';
import type { StrategyModule, StratRow, OpenPos, ExitEvent, EntryPlan, StratScan } from './types';
import { calcShares, starsFromScore, meanOfPrev, atrArr, rsiSimple, cciArr, slowStochArr, detectCandle, atrTrailSl, daysElapsed, dailyChangePct } from './engine';

const PARAMS = {
  boxPeriod: 25, boxWidthMin: 6, boxWidthMax: 18, touchBand: 1.5, touchMin: 2,
  nearBottomPct: 2, volDryRatio: 0.7, rsiLo: 30, rsiHi: 50, stochMax: 30, cciRecover: -100,
  slBoxBufferPct: 2, slPct: 3, tp1Ratio: 0.4, tp2Ratio: 0.4, atrTrailMult: 1.5,
  breakoutFailBars: 3, maxDays: 5, minReturnByMaxDays: 2, positionPct: 15,
};

function compute(candles: Candle[]): StratRow[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const rsi = rsiSimple(closes, 14);
  const cci = cciArr(highs, lows, closes, 20);
  const { k: stochK, d: stochD } = slowStochArr(highs, lows, closes, 14, 3, 3);
  const atr = atrArr(highs, lows, closes, 14);

  return candles.map((c, i) => {
    let top: number | null = null, bottom: number | null = null, width: number | null = null;
    let touchesOk = false, notTriangle = true;
    if (i >= PARAMS.boxPeriod - 1) {
      const hi = highs.slice(i - PARAMS.boxPeriod + 1, i + 1);
      const lo = lows.slice(i - PARAMS.boxPeriod + 1, i + 1);
      top = Math.max(...hi);
      bottom = Math.min(...lo);
      width = bottom > 0 ? ((top - bottom) / bottom) * 100 : null;

      const topTouches = hi.filter((h) => h >= top! * (1 - PARAMS.touchBand / 100)).length;
      const bottomTouches = lo.filter((l) => l <= bottom! * (1 + PARAMS.touchBand / 100)).length;
      touchesOk = topTouches >= PARAMS.touchMin && bottomTouches >= PARAMS.touchMin;

      const half = Math.floor(hi.length / 2);
      const firstHighMax = Math.max(...hi.slice(0, half));
      const secondHighMax = Math.max(...hi.slice(half));
      const firstLowMin = Math.min(...lo.slice(0, half));
      const secondLowMin = Math.min(...lo.slice(half));
      const triangle = firstHighMax > secondHighMax && firstLowMin < secondLowMin;
      notTriangle = !triangle;
    }
    const tightBox = width != null && width >= PARAMS.boxWidthMin && width <= PARAMS.boxWidthMax;
    const validBox = tightBox && touchesOk && notTriangle;

    const nearBottom = bottom != null && c.close <= bottom * (1 + PARAMS.nearBottomPct / 100) && c.close >= bottom;

    const volAvg5 = meanOfPrev(volumes, 5, i);
    const volAvg20 = meanOfPrev(volumes, 20, i);
    const dryUp = volAvg5 != null && volAvg20 != null && volAvg20 > 0 && volAvg5 <= volAvg20 * PARAMS.volDryRatio;

    const prev = i > 0 ? candles[i - 1] : undefined;
    const pattern = detectCandle(c, prev);
    const reboundCandle = pattern.hammer || pattern.bullishEngulfing || pattern.bigBull;

    const rsiOk = rsi[i] != null && (rsi[i] as number) >= PARAMS.rsiLo && (rsi[i] as number) <= PARAMS.rsiHi;

    const k = stochK[i], d = stochD[i], pk = i > 0 ? stochK[i - 1] : null, pd = i > 0 ? stochD[i - 1] : null;
    const stochGC = k != null && d != null && pk != null && pd != null && k > d && pk <= pd && k <= PARAMS.stochMax + 10;

    const cciOk = cci[i] != null && (cci[i] as number) >= PARAMS.cciRecover &&
      i > 0 && cci[i - 1] != null && (cci[i - 1] as number) < PARAMS.cciRecover;

    const buy = !!(validBox && nearBottom && dryUp && reboundCandle && rsiOk && stochGC && cciOk);
    const exit = top != null && c.close > top;

    return {
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      buy, exit,
      lines: { boxTop: top, boxBottom: bottom },
      m: { boxWidth: width, validBox: validBox ? 1 : 0, dryUp: dryUp ? 1 : 0, rsi: rsi[i], cci: cci[i], atr: atr[i], boxTop: top, boxBottom: bottom },
    };
  });
}

function planEntry(rows: StratRow[], i: number, cash: number): EntryPlan | null {
  const row = rows[i];
  const bottom = row.lines.boxBottom;
  if (bottom == null) return null;
  const entry = row.close;
  const sl = Math.max(bottom * (1 - PARAMS.slBoxBufferPct / 100), entry * (1 - PARAMS.slPct / 100));
  if (sl >= entry) return null;
  const shares = calcShares(cash, PARAMS.positionPct, entry);
  if (shares <= 0) return null;
  return { entry_price: entry, shares, sl, note: `박스권 하단 매수 · 손절가 ${Math.round(sl).toLocaleString('ko-KR')}` };
}

function stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null } {
  const events: ExitEvent[] = [];
  let { shares, sl, tp1_hit } = pos;
  const entry = pos.entry_price;
  const top = row.lines.boxTop, bottom = row.lines.boxBottom;
  const atrNow = (row.m.atr as number | null) ?? null;

  if (row.close <= sl) {
    events.push({ side: 'SELL_SL', price: row.close, shares, pnl: shares * (row.close - entry), note: '손절 청산', time: row.time });
    return { events, updated: null };
  }
  const mid = top != null && bottom != null ? (top + bottom) / 2 : null;
  if (!tp1_hit && mid != null && row.close >= mid) {
    const chunk = shares * PARAMS.tp1Ratio;
    events.push({ side: 'SELL_TP1', price: row.close, shares: chunk, pnl: chunk * (row.close - entry), note: '박스 중앙 도달 익절', time: row.time });
    shares -= chunk;
    tp1_hit = true;
    sl = Math.max(sl, entry); // 본절 이상 확보
  }
  if (tp1_hit && top != null && row.close >= top * 0.99 && shares > 0) {
    const chunk = shares * (PARAMS.tp2Ratio / (1 - PARAMS.tp1Ratio));
    const sell = Math.min(shares, chunk);
    events.push({ side: 'SELL_TP1', price: row.close, shares: sell, pnl: sell * (row.close - entry), note: '박스 상단 근접 추가 익절', time: row.time });
    shares -= sell;
  }
  if (shares > 0 && atrNow != null && tp1_hit) sl = atrTrailSl(sl, row.high, atrNow, PARAMS.atrTrailMult);
  if (shares > 0 && row.close <= sl && tp1_hit) {
    events.push({ side: 'SELL_TP2', price: sl, shares, pnl: shares * (sl - entry), note: 'ATR 트레일링 청산 (박스 돌파 후)', time: row.time });
    return { events, updated: null };
  }
  const days = daysElapsed(row.time, pos.opened_at);
  const profitPct = ((row.close - entry) / entry) * 100;
  if (shares > 0 && days >= PARAMS.maxDays && profitPct < PARAMS.minReturnByMaxDays) {
    events.push({ side: 'SELL_TP2', price: row.close, shares, pnl: shares * (row.close - entry), note: '보유기간 만료 청산', time: row.time });
    return { events, updated: null };
  }
  if (shares <= 0) return { events, updated: null };
  return { events, updated: { ...pos, shares, sl, tp1_hit } };
}

function scan(symbol: string, name: string, rows: StratRow[]): StratScan {
  const last = rows[rows.length - 1];
  const price = last?.close ?? 0;
  const changePct = dailyChangePct(rows);
  const boxWidth = last?.m.boxWidth ?? null;
  const validBox = last?.m.validBox === 1;
  const dryUp = last?.m.dryUp === 1;
  const rsi = last?.m.rsi ?? null;
  const rsiOk = rsi != null && rsi >= PARAMS.rsiLo && rsi <= PARAMS.rsiHi;
  const bottom = last?.m.boxBottom ?? null;
  const nearBottom = bottom != null && last.close <= bottom * (1 + PARAMS.nearBottomPct / 100);

  const conditions = [
    { label: `박스권 형성 (폭 ${PARAMS.boxWidthMin}~${PARAMS.boxWidthMax}%, 터치≥${PARAMS.touchMin}회)`, met: validBox, pts: 20 },
    { label: '박스 하단 근접', met: nearBottom, pts: 20 },
    { label: '조정기 거래량 감소', met: dryUp, pts: 15 },
    { label: `RSI ${PARAMS.rsiLo}~${PARAMS.rsiHi}`, met: rsiOk, pts: 15 },
    { label: '반등 신호 (매수)', met: last?.buy ?? false, pts: 30 },
  ];
  const score = conditions.reduce((a, c) => a + (c.met ? c.pts : 0), 0);

  return {
    symbol, name, price, changePct,
    buy: last?.buy ?? false,
    exit: last?.exit ?? false,
    score, stars: starsFromScore(score),
    cols: [
      { value: boxWidth != null ? boxWidth.toFixed(1) + '%' : '-', tone: validBox ? 'accent' : 'default' },
      { value: nearBottom ? '하단근접' : '-', tone: nearBottom ? 'up' : 'muted' },
      { value: rsi != null ? rsi.toFixed(0) : '-', tone: rsiOk ? 'up' : 'default' },
    ],
    conditions,
  };
}

export const rangeswing: StrategyModule = {
  code: 'rangeswing',
  name: '전략9 · (횡보) 박스권 스윙',
  short: '일봉 기준 최근 25일 박스(폭 6~18%, 상하단 각 2회 이상 터치, 삼각수렴 제외) 하단 근접 + 거래량 감소 + 반등캔들 + RSI 30~50 + Slow Stoch 골든크로스 + CCI -100 회복 시 매수. 박스 중앙/상단 분할익절 후 돌파 시 ATR 트레일, 5일 시간청산.',
  interval: '1d',
  range: '1y',
  positionPct: PARAMS.positionPct,
  params: PARAMS,
  regime: 'SIDEWAYS', risk: 3,
  regimeFit: { BULL_MAJOR: 10, BULL: 25, RANGE: 95, BEAR: 10 },
  lineStyles: [
    { key: 'boxTop', color: '#22c55e', width: 2, label: '박스 상단' },
    { key: 'boxBottom', color: '#ef4444', width: 2, label: '박스 하단' },
  ],
  colHeaders: ['박스폭', '위치', 'RSI'],
  rules: [
    { tag: '①', color: 'text-accent', title: '박스 확인', body: '최근 25일 고저로 정의한 박스 폭이 6~18%이고, 상단/하단 각각 2회 이상 터치했으며 삼각수렴(고점 하락+저점 상승 동시)이 아닐 때만 유효.' },
    { tag: '②', color: 'text-accent', title: '진입', body: '종가가 박스 하단 2% 이내(미이탈) + 조정기 거래량 감소 + 반등캔들 + RSI 30~50 + Slow Stochastic 골든크로스 + CCI -100 상향 회복 시 가용 현금 15% 매수.' },
    { tag: '③', color: 'text-amber-400', title: '손절', body: 'max(박스 하단 -2%, 진입가 -3%) 중 타이트한 값.' },
    { tag: '④', color: 'text-profit', title: '청산', body: '박스 중앙 도달 시 40% 익절(손절가 본절 이동), 박스 상단 근접 시 추가 40% 익절. 잔여는 박스 돌파 후 ATR×1.5 트레일링, 5거래일 경과 시 수익 2% 미만이면 잔여 전량 청산.' },
  ],
  compute, scan, planEntry, stepOpen,
};
