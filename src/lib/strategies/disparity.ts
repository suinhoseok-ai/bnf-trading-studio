// ===== 전략7: 25일 EMA 이격도 + RSI/MACD 오실레이터 (BNF 낙주 매매) =====
// 종가가 25 EMA에서 과도하게 하락 이격 + 지지선 도달 + RSI(14)≤30 + MACD 히스토그램 상승 반전(저점 전환) 시 매수.
// 진입 시 손절(지지선 이탈)·1:2 손익비 익절을 확정. 시장국면(KOSPI 200일선)에 따라 이격도 기준 동적 적용.
//
// 명세서 해석 주의:
//  - "시장 국면"은 개별 종목이 아닌 시장 지수(KOSPI) 기준으로 판단한다(스켈레톤의 종목 200SMA는 임시 구현).
//  - "MACD 히스토그램 반전 트리거"는 급락 바닥에서의 모멘텀 전환(히스토그램 저점→상승)으로 해석한다.
//    (엄격한 0선 상향 교차는 급락 후 가격이 이미 크게 회복된 뒤에야 발생하여 과매도 조건과 동시 성립이 불가능하다.)
import type { Candle } from '../types';
import type { StrategyModule, StratRow, OpenPos, ExitEvent, EntryPlan, StratScan, CandleFetcher } from './types';
import { calcShares, starsFromScore, emaArr, smaAt, minOfPrev, rsiSimple } from './engine';

const PARAMS = {
  emaPeriod: 25, rsiPeriod: 14, rsiThresh: 30,
  bullDisparity: 20, bearDisparity: 30, // 시장국면별 하락 이격도 기준(%)
  supportLookback: 40, supportBand: 2, riskReward: 2, positionPct: 20,
};
const INDEX_SYMBOL = '^KS11';
const INDEX_TTL = 10 * 60_000;

// ── 시장 지수(KOSPI) 200일선 캐시 ──
let indexBars: { time: number; close: number; sma200: number | null }[] = [];
let indexLoadedAt = 0;

async function init(fetch: CandleFetcher): Promise<void> {
  if (indexBars.length > 0 && Date.now() - indexLoadedAt < INDEX_TTL) return;
  try {
    const candles = await fetch(INDEX_SYMBOL, '1d', '2y');
    const closes = candles.map((c) => c.close);
    indexBars = candles.map((c, i) => ({ time: c.time, close: c.close, sma200: smaAt(closes, 200, i) }));
    indexLoadedAt = Date.now();
  } catch { /* 실패 시 기존 캐시 유지 */ }
}

/** 해당 시점 시장 국면: true=상승장, false=하락장, null=판단불가 */
function bullAt(time: number): boolean | null {
  if (indexBars.length === 0) return null;
  let lo = 0, hi = indexBars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (indexBars[mid].time <= time + 43_200) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0) return null;
  const b = indexBars[ans];
  return b.sma200 == null ? null : b.close >= b.sma200;
}

function compute(candles: Candle[]): StratRow[] {
  const closes = candles.map((c) => c.close);
  const lows = candles.map((c) => c.low);
  const ema25 = emaArr(closes, PARAMS.emaPeriod);
  const ema12 = emaArr(closes, 12);
  const ema26 = emaArr(closes, 26);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
  const signal = emaArr(macdLine, 9);
  const hist = macdLine.map((v, i) => v - signal[i]);
  const rsi = rsiSimple(closes, PARAMS.rsiPeriod);

  return candles.map((c, i) => {
    const bull = bullAt(c.time);
    const reqDisp = bull === false ? PARAMS.bearDisparity : PARAMS.bullDisparity;
    const disparity = ema25[i] !== 0 ? ((ema25[i] - c.close) / ema25[i]) * 100 : null; // 하락 이격도(+)
    const support = minOfPrev(lows, PARAMS.supportLookback, i);
    // MACD 히스토그램 저점 전환(반전): 직전보다 상승 & 그 이전엔 하락 (히스토그램 골)
    const histTrough = i >= 2 && hist[i] > hist[i - 1] && hist[i - 1] <= hist[i - 2];

    const condA = disparity != null && disparity >= reqDisp;
    const condB = support != null && c.low <= support * (1 + PARAMS.supportBand / 100);
    const condC = rsi[i] != null && (rsi[i] as number) <= PARAMS.rsiThresh;
    const condD = histTrough;

    return {
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      buy: !!(bull != null && condA && condB && condC && condD),
      exit: ema25[i] !== 0 && c.close > ema25[i], // 25EMA 회복 = 이격 해소(익절) 신호
      lines: { ema25: ema25[i], support },
      m: { disparity, rsi: rsi[i], macdHist: hist[i], regime: bull == null ? null : bull ? 1 : 0, support },
    };
  });
}

function planEntry(rows: StratRow[], i: number, cash: number): EntryPlan | null {
  const row = rows[i];
  const entry = row.close;
  const support = row.lines.support;
  const sl = Math.min((support ?? entry * 0.97) * 0.99, entry * 0.98); // 지지선 -1% 또는 진입가 -2% 중 낮은 값
  const shares = calcShares(cash, PARAMS.positionPct, entry);
  if (shares <= 0 || sl >= entry) return null;
  const tp = entry + (entry - sl) * PARAMS.riskReward;
  return { entry_price: entry, shares, sl, note: `낙주 매수 · 손절 ${Math.round(sl).toLocaleString('ko-KR')} · 목표 ${Math.round(tp).toLocaleString('ko-KR')} (1:${PARAMS.riskReward})` };
}

function stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null } {
  const entry = pos.entry_price;
  const sl = pos.sl;
  const tp = entry + (entry - sl) * PARAMS.riskReward; // 진입가·손절가로 재계산(무상태)
  // 1. 절대 손절 (지지선 이탈)
  if (row.low <= sl) {
    return { events: [{ side: 'SELL_SL', price: sl, shares: pos.shares, pnl: pos.shares * (sl - entry), note: '지지선 이탈 손절', time: row.time }], updated: null };
  }
  // 2. 목표가 익절 (1:2 손익비)
  if (row.high >= tp) {
    return { events: [{ side: 'SELL_TP2', price: tp, shares: pos.shares, pnl: pos.shares * (tp - entry), note: '목표가 익절 (1:2)', time: row.time }], updated: null };
  }
  return { events: [], updated: pos };
}

function scan(symbol: string, name: string, rows: StratRow[]): StratScan {
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const prev2 = rows[rows.length - 3];
  const price = last?.close ?? 0;
  const changePct = prev ? ((last.close - prev.close) / prev.close) * 100 : 0;
  const disparity = last?.m.disparity ?? null;
  const rsi = last?.m.rsi ?? null;
  const hist = last?.m.macdHist ?? null;
  const regime = last?.m.regime;
  const support = last?.m.support ?? null;

  const reqDisp = regime === 0 ? PARAMS.bearDisparity : PARAMS.bullDisparity;
  const condA = disparity != null && disparity >= reqDisp;
  const condB = support != null && last.low <= support * (1 + PARAMS.supportBand / 100);
  const condC = rsi != null && rsi <= PARAMS.rsiThresh;
  const histTrough = hist != null && prev?.m.macdHist != null && prev2?.m.macdHist != null &&
    hist > (prev.m.macdHist as number) && (prev.m.macdHist as number) <= (prev2.m.macdHist as number);
  const dispHalf = disparity != null && disparity >= reqDisp / 2;

  const conditions = [
    { label: `하락 이격도 ${reqDisp}% 이상 (${regime === 0 ? '하락장' : '상승장'})`, met: condA, pts: 30 },
    { label: '지지선 도달 (2% 이내)', met: condB, pts: 20 },
    { label: 'RSI(14) ≤ 30 과매도', met: condC, pts: 25 },
    { label: 'MACD 히스토그램 상승 반전', met: !!histTrough, pts: 20 },
    { label: `하락 이격도 ${Math.round(reqDisp / 2)}% 이상`, met: dispHalf, pts: 5 },
  ];
  const score = conditions.reduce((a, c) => a + (c.met ? c.pts : 0), 0);

  return {
    symbol, name, price, changePct,
    buy: last?.buy ?? false,
    exit: last?.exit ?? false,
    score, stars: starsFromScore(score),
    cols: [
      { value: disparity != null ? disparity.toFixed(1) + '%' : '-', tone: condA ? 'accent' : disparity != null && disparity > 0 ? 'down' : 'default' },
      { value: rsi != null ? rsi.toFixed(0) : '-', tone: condC ? 'accent' : 'default' },
      { value: histTrough ? '반전' : hist == null ? '-' : hist > 0 ? '양(+)' : '음(−)', tone: histTrough ? 'up' : 'muted' },
    ],
    conditions,
  };
}

export const disparity: StrategyModule = {
  code: 'disparity',
  name: '전략7 · 25일 EMA 이격도 낙주',
  short: '종가가 25 EMA에서 과도 하락 이격 + 지지선 도달 + RSI(14)≤30 + MACD 히스토그램 상승 반전 시 낙주 매수. 지지선 이탈 손절, 1:2 손익비 익절. (시장국면=KOSPI 200일선)',
  interval: '1d',
  range: '2y',
  positionPct: PARAMS.positionPct,
  params: PARAMS,
  lineStyles: [
    { key: 'ema25', color: '#f59e0b', width: 2, label: 'EMA25' },
    { key: 'support', color: '#ef4444', width: 1, label: '지지선(최근 저점)' },
  ],
  colHeaders: ['하락이격도', 'RSI', 'MACD'],
  rules: [
    { tag: '①', color: 'text-accent', title: '진입', body: '종가가 25 EMA 대비 이격도 기준 이상 하락(상승장 20%·하락장 30%), 지지선 도달, RSI(14)≤30, MACD 히스토그램이 바닥에서 상승 반전할 때 가용 현금 20% 매수. 시장국면은 KOSPI 200일선으로 판단.' },
    { tag: '②', color: 'text-amber-400', title: '절대 손절', body: '진입 근거인 지지선(최근 저점) 아래를 이탈하면 즉시 전량 손절. 물타기·존버 금지.' },
    { tag: '③', color: 'text-profit', title: '익절', body: '손절 리스크 대비 2배 수익(1:2 손익비) 목표가 도달 시 전량 익절.' },
    { tag: '④', color: 'text-slate-300', title: '특성', body: '급락장 과매도 반등을 노리는 역추세 단타. 극단적 이격에서만 신호가 발생하므로 평상시엔 관망이 정상.' },
  ],
  init, compute, scan, planEntry, stepOpen,
};
