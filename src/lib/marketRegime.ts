// ===== 시장국면 판단 엔진 v2 (5국면 + 전환구간) =====
// 대표지수(KOSPI ^KS11 / KOSDAQ ^KQ11) 일봉으로 국면을 판정한다.
// 국면: BULL_MAJOR(대세상승) / BULL(상승) / RANGE(횡보) / BEAR(하락) / BEAR_MAJOR(대세하락) / TRANSITION(전환구간)
// - classifyFromCandles(): 단발 후보 판정 (신뢰도·근거·비상감지 포함). 히스테리시스 없음.
// - stabilize(): 후보를 연속 확인일수(streak)로 안정화해 '확정 국면'을 만든다 (서버 regime.mts 전용).
// - coarseRegime(): 6국면을 기존 전략 메타(BULL/SIDEWAYS/BEAR)의 3분류로 사상 (게이트·추천 호환용).
// 캔들 fetcher를 주입받아 서버(Yahoo 직접)와 클라이언트(/api/yahoo 프록시) 양쪽에서 재사용한다.
import type { Candle } from './types';
import { smaAt, stddevAt, adxArr, atrArr, rsiSimple } from './strategies/engine';

export type Regime = 'BULL_MAJOR' | 'BULL' | 'RANGE' | 'BEAR' | 'BEAR_MAJOR' | 'TRANSITION';
export type CoarseRegime = 'BULL' | 'SIDEWAYS' | 'BEAR';
export type RiskState = 'NORMAL' | 'EMERGENCY_RISK_OFF' | 'DATA_INVALID';
export type Market = 'KOSPI' | 'KOSDAQ';

export type CandleFetcher = (symbol: string, interval: string, range: string) => Promise<Candle[]>;

export interface RegimeEvidence { label: string; met: boolean; value: string }

export interface RegimeMetrics {
  close: number;
  sma50: number | null;
  sma200: number | null;
  slope200: number | null;   // SMA200 20일 기울기 (비율)
  roc60: number | null;
  roc120: number | null;
  adx: number | null;
  plusDI: number | null;
  minusDI: number | null;
  atrPct: number | null;
  changePct: number;         // 최근봉 전일대비 등락률 (비상감지용)
  breadth: number | null;    // 시장폭 (close>SMA50 비율), 서버 전용·없으면 null
  trendUp: number;
  trendDown: number;
  maxTrendScore: number;
}

/** 미세 시장상태 태그 (설계서 08 §6 축약: 8종). 복수 동시 성립 가능. */
export type MicroTag =
  | 'TREND_ACCELERATION' | 'VOLATILITY_COMPRESSION' | 'ORDERLY_PULLBACK' | 'RANGE_REVERSION'
  | 'OVERSOLD_PANIC' | 'TREND_BREAKDOWN' | 'OVERHEATED' | 'VOLATILITY_SHOCK';

export interface RegimeResult {
  market: Market;
  candidate: Regime;
  confidence: number;        // 0~1
  riskState: RiskState;
  evidence: RegimeEvidence[];
  metrics: RegimeMetrics;
  microTags: MicroTag[];
  price: number;
  /** classify 시점의 각 국면 조건 충족 여부 (stabilize의 '직전 확정 유지' 판단에 사용) */
  flags: Record<Exclude<Regime, 'TRANSITION'>, boolean>;
}

// 설정값 (설계서 01 §4)
const P = {
  slopeMajor: 0.005,   // 대세 기울기 임계 (±0.5%)
  rocMajor: 0.15,      // 대세 ROC120 임계 (±15%)
  strongAdx: 25,
  weakAdx: 20,
  nearMa200: 0.03,     // 횡보 판정 SMA200 근접 밴드 (±3%)
  rangeRoc: 0.05,      // 횡보 판정 ROC60 밴드 (±5%)
  breadthBull: 0.60,
  breadthBear: 0.40,
  emergencyDrop: -0.07, // 당일 -7% 이하 → 비상 리스크오프
  confirmUp: 3,        // 상향/일반 전환 확정 연속일수
  confirmDown: 2,      // 하향 전환 확정 연속일수 (더 빠르게 방어)
};

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const num = (n: number | null) => (n != null ? String(Math.round(n)) : '-');
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function rocAt(closes: number[], period: number, i: number): number | null {
  if (i < period || closes[i - period] <= 0) return null;
  return closes[i] / closes[i - period] - 1;
}

function median(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 미세 시장상태 태그 8종 (설계서 08 §6.2 축약). 복수 성립 가능, 조건 불충분이면 빈 배열.
 */
function computeMicroTags(
  candles: Candle[], i: number,
  adx: (number | null)[], plusDI: (number | null)[], minusDI: (number | null)[], atr: (number | null)[],
): MicroTag[] {
  const closes = candles.map((c) => c.close);
  const tags: MicroTag[] = [];
  if (i < 20) return tags;

  const sma20 = smaAt(closes, 20, i);
  const std20 = stddevAt(closes, 20, i);
  const rsi14 = rsiSimple(closes, 14)[i];
  const roc20 = rocAt(closes, 20, i);
  const roc20Prev = i >= 23 ? rocAt(closes, 20, i - 3) : null;
  const adxNow = adx[i], plusNow = plusDI[i], minusNow = minusDI[i];
  const atrNow = atr[i];
  const atrPctNow = atrNow != null && closes[i] > 0 ? atrNow / closes[i] : null;
  const changePct = i >= 1 && closes[i - 1] > 0 ? closes[i] / closes[i - 1] - 1 : 0;

  // TREND_ACCELERATION: ADX≥25, +DI>-DI, ROC20 상승 중
  if (adxNow != null && adxNow >= 25 && plusNow != null && minusNow != null && plusNow > minusNow &&
      roc20 != null && roc20Prev != null && roc20 > roc20Prev) {
    tags.push('TREND_ACCELERATION');
  }

  // VOLATILITY_COMPRESSION: 밴드폭 백분위(120) ≤20%, ATR%가 50일 평균의 85% 미만
  if (i >= 119) {
    const widths: number[] = [];
    for (let j = i - 119; j <= i; j++) {
      const m = smaAt(closes, 20, j), sd = stddevAt(closes, 20, j);
      if (m != null && sd != null && m !== 0) widths.push((4 * sd) / m); // (mid+2σ)-(mid-2σ) = 4σ
    }
    if (widths.length >= 60 && sma20 != null && std20 != null && sma20 !== 0) {
      const curWidth = (4 * std20) / sma20;
      const below = widths.filter((w) => w <= curWidth).length;
      const pctRank = below / widths.length;
      const atrPctArr = atr.map((v, idx) => (v != null && closes[idx] > 0 ? v / closes[idx] : null));
      const atrAvg50 = smaAt(atrPctArr, 50, i);
      if (pctRank <= 0.20 && atrPctNow != null && atrAvg50 != null && atrPctNow < atrAvg50 * 0.85) {
        tags.push('VOLATILITY_COMPRESSION');
      }
    }
  }

  // ORDERLY_PULLBACK: 50일선 위 + RSI 38~52 + 종가가 20일선 ±1ATR 이내
  const sma50Now = smaAt(closes, 50, i);
  if (sma50Now != null && closes[i] > sma50Now && rsi14 != null && rsi14 >= 38 && rsi14 <= 52 &&
      sma20 != null && atrNow != null && Math.abs(closes[i] - sma20) <= atrNow) {
    tags.push('ORDERLY_PULLBACK');
  }

  // RANGE_REVERSION: ADX<20, |ROC20|≤3%
  if (adxNow != null && adxNow < 20 && roc20 != null && Math.abs(roc20) <= 0.03) {
    tags.push('RANGE_REVERSION');
  }

  // OVERSOLD_PANIC: RSI≤20 + 당일 3% 이상 급락 (과매도 투매)
  if (rsi14 != null && rsi14 <= 20 && changePct <= -0.03) {
    tags.push('OVERSOLD_PANIC');
  }

  // TREND_BREAKDOWN: -DI>+DI, ADX≥25, 200일선 아래
  const sma200Now = smaAt(closes, 200, i);
  if (plusNow != null && minusNow != null && minusNow > plusNow && adxNow != null && adxNow >= 25 &&
      sma200Now != null && closes[i] < sma200Now) {
    tags.push('TREND_BREAKDOWN');
  }

  // OVERHEATED: RSI≥75 또는 20일선 이격 2.5ATR 초과
  if ((rsi14 != null && rsi14 >= 75) || (sma20 != null && atrNow != null && atrNow > 0 && Math.abs(closes[i] - sma20) > 2.5 * atrNow)) {
    tags.push('OVERHEATED');
  }

  // VOLATILITY_SHOCK: ATR%가 최근 60봉 중앙값의 1.8배 초과
  if (i >= 59) {
    const atrPctWindow: number[] = [];
    for (let j = i - 59; j <= i; j++) {
      const v = atr[j];
      if (v != null && closes[j] > 0) atrPctWindow.push(v / closes[j]);
    }
    const med = median(atrPctWindow);
    if (med != null && atrPctNow != null && atrPctNow > med * 1.8) tags.push('VOLATILITY_SHOCK');
  }

  return tags;
}

/**
 * 캔들(일봉)로 후보 국면을 판정한다. breadth는 서버에서만 계산해 주입(없으면 null).
 * 히스테리시스는 적용하지 않는다 — 확정은 stabilize()가 담당한다.
 */
export function classifyFromCandles(candles: Candle[], market: Market, breadth: number | null = null): RegimeResult {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const i = candles.length - 1;
  const close = closes[i] ?? 0;

  const sma50 = smaAt(closes, 50, i);
  const sma200 = smaAt(closes, 200, i);
  const sma200Prev = i >= 20 ? smaAt(closes, 200, i - 20) : null;
  const slope200 = sma200 != null && sma200Prev != null && sma200Prev !== 0 ? sma200 / sma200Prev - 1 : null;
  const roc60 = rocAt(closes, 60, i);
  const roc120 = rocAt(closes, 120, i);
  const { adx, plusDI, minusDI } = adxArr(highs, lows, closes, 14);
  const adxNow = adx[i], plusNow = plusDI[i], minusNow = minusDI[i];
  const atr = atrArr(highs, lows, closes, 14);
  const atrPct = atr[i] != null && close > 0 ? (atr[i] as number) / close : null;
  const changePct = i >= 1 && closes[i - 1] > 0 ? closes[i] / closes[i - 1] - 1 : 0;

  // trend 투표 점수 (breadth 없으면 7점 만점)
  const hasBreadth = breadth != null;
  const maxTrendScore = hasBreadth ? 8 : 7;
  const b = (v: boolean, w: number) => (v ? w : 0);
  const trendUp =
    b(sma200 != null && close > sma200, 2) +
    b(sma50 != null && sma200 != null && sma50 > sma200, 2) +
    b(slope200 != null && slope200 > 0, 1) +
    b(roc60 != null && roc60 > 0, 1) +
    b(plusNow != null && minusNow != null && plusNow > minusNow, 1) +
    (hasBreadth ? b((breadth as number) >= 0.5, 1) : 0);
  const trendDown =
    b(sma200 != null && close < sma200, 2) +
    b(sma50 != null && sma200 != null && sma50 < sma200, 2) +
    b(slope200 != null && slope200 < 0, 1) +
    b(roc60 != null && roc60 < 0, 1) +
    b(plusNow != null && minusNow != null && minusNow > plusNow, 1) +
    (hasBreadth ? b((breadth as number) <= 0.5, 1) : 0);

  const microTags = computeMicroTags(candles, i, adx, plusDI, minusDI, atr);

  const metrics: RegimeMetrics = {
    close, sma50, sma200, slope200, roc60, roc120,
    adx: adxNow, plusDI: plusNow, minusDI: minusNow, atrPct, changePct, breadth,
    trendUp, trendDown, maxTrendScore,
  };

  // 데이터 품질 게이트: SMA200/ADX 계산 불가 → DATA_INVALID (안전하게 TRANSITION)
  const dataInvalid = sma200 == null || adxNow == null || close <= 0;
  const riskState: RiskState = dataInvalid ? 'DATA_INVALID'
    : changePct <= P.emergencyDrop ? 'EMERGENCY_RISK_OFF'
    : 'NORMAL';

  // 국면 조건 (우선순위: BULL_MAJOR > BEAR_MAJOR > BULL > BEAR > RANGE > TRANSITION)
  const bullMajor = !dataInvalid &&
    close > (sma200 as number) && sma50 != null && sma50 > (sma200 as number) &&
    slope200 != null && slope200 >= P.slopeMajor && roc120 != null && roc120 >= P.rocMajor &&
    (adxNow as number) >= P.strongAdx && plusNow != null && minusNow != null && plusNow > minusNow &&
    (breadth == null || breadth >= P.breadthBull);
  const bearMajor = !dataInvalid &&
    close < (sma200 as number) && sma50 != null && sma50 < (sma200 as number) &&
    slope200 != null && slope200 <= -P.slopeMajor && roc120 != null && roc120 <= -P.rocMajor &&
    (adxNow as number) >= P.strongAdx && plusNow != null && minusNow != null && minusNow > plusNow &&
    (breadth == null || breadth <= P.breadthBear);
  const bull = !dataInvalid && !bullMajor &&
    close > (sma200 as number) && sma50 != null && sma50 >= (sma200 as number) &&
    slope200 != null && slope200 > 0 && roc60 != null && roc60 > 0 && trendUp >= 5;
  const bear = !dataInvalid && !bearMajor &&
    close < (sma200 as number) && sma50 != null && sma50 <= (sma200 as number) &&
    slope200 != null && slope200 < 0 && roc60 != null && roc60 < 0 && trendDown >= 5;
  const range = !dataInvalid &&
    Math.abs(close - (sma200 as number)) / (sma200 as number) <= P.nearMa200 &&
    (adxNow as number) < P.weakAdx && roc60 != null && Math.abs(roc60) <= P.rangeRoc;

  const flags = { BULL_MAJOR: bullMajor, BEAR_MAJOR: bearMajor, BULL: bull, BEAR: bear, RANGE: range };

  let candidate: Regime = 'TRANSITION';
  if (bullMajor) candidate = 'BULL_MAJOR';
  else if (bearMajor) candidate = 'BEAR_MAJOR';
  else if (bull) candidate = 'BULL';
  else if (bear) candidate = 'BEAR';
  else if (range) candidate = 'RANGE';

  // 신뢰도 (채택 국면 기준)
  let confidence: number;
  if (candidate === 'BULL_MAJOR' || candidate === 'BULL') confidence = trendUp / maxTrendScore;
  else if (candidate === 'BEAR_MAJOR' || candidate === 'BEAR') confidence = trendDown / maxTrendScore;
  else if (candidate === 'RANGE') confidence = clamp(1 - Math.abs(close - (sma200 as number)) / (sma200 as number) / P.nearMa200, 0.3, 1);
  else confidence = Math.max(trendUp, trendDown) / maxTrendScore; // TRANSITION: 낮게

  const evidence = buildEvidence(candidate, metrics);

  return { market, candidate, confidence, riskState, evidence, metrics, microTags, price: close, flags };
}

function buildEvidence(regime: Regime, m: RegimeMetrics): RegimeEvidence[] {
  const bullFamily = regime === 'BULL_MAJOR' || regime === 'BULL';
  const bearFamily = regime === 'BEAR_MAJOR' || regime === 'BEAR';
  const c = m.close;
  if (bullFamily || regime === 'TRANSITION' || bearFamily) {
    const rows: RegimeEvidence[] = [
      { label: 'Close > SMA200', met: m.sma200 != null && c > m.sma200, value: num(m.sma200) },
      { label: 'SMA50 > SMA200', met: m.sma50 != null && m.sma200 != null && m.sma50 > m.sma200, value: `${num(m.sma50)}/${num(m.sma200)}` },
      { label: 'SLOPE200 > 0', met: m.slope200 != null && m.slope200 > 0, value: m.slope200 != null ? pct(m.slope200) : '-' },
      { label: 'ROC60 > 0', met: m.roc60 != null && m.roc60 > 0, value: m.roc60 != null ? pct(m.roc60) : '-' },
      { label: 'ROC120 (±15% 대세)', met: m.roc120 != null && Math.abs(m.roc120) >= P.rocMajor, value: m.roc120 != null ? pct(m.roc120) : '-' },
      { label: `ADX ≥ ${P.strongAdx}`, met: m.adx != null && m.adx >= P.strongAdx, value: m.adx != null ? m.adx.toFixed(1) : '-' },
      { label: '+DI > -DI', met: m.plusDI != null && m.minusDI != null && m.plusDI > m.minusDI, value: m.plusDI != null && m.minusDI != null ? `${m.plusDI.toFixed(0)}/${m.minusDI.toFixed(0)}` : '-' },
    ];
    if (m.breadth != null) rows.push({ label: '시장폭(≥60% 강세)', met: m.breadth >= 0.5, value: `${(m.breadth * 100).toFixed(0)}%` });
    if (regime === 'TRANSITION') rows.push({ label: `추세점수 상승 ${m.trendUp} / 하락 ${m.trendDown} (기준 5)`, met: false, value: `${m.maxTrendScore}점 만점` });
    return rows;
  }
  // RANGE
  return [
    { label: 'SMA200 ±3% 근접', met: m.sma200 != null && Math.abs(c - m.sma200) / m.sma200 <= P.nearMa200, value: m.sma200 != null ? pct((c - m.sma200) / m.sma200) : '-' },
    { label: `ADX < ${P.weakAdx} (추세 약함)`, met: m.adx != null && m.adx < P.weakAdx, value: m.adx != null ? m.adx.toFixed(1) : '-' },
    { label: 'ROC60 ±5% 이내', met: m.roc60 != null && Math.abs(m.roc60) <= P.rangeRoc, value: m.roc60 != null ? pct(m.roc60) : '-' },
    { label: 'ATR% (변동성)', met: false, value: m.atrPct != null ? pct(m.atrPct) : '-' },
  ];
}

const ORD: Record<Regime, number> = { BULL_MAJOR: 2, BULL: 1, RANGE: 0, TRANSITION: 0, BEAR: -1, BEAR_MAJOR: -2 };

export interface StabilizeResult { confirmed: Regime; streak: number }

/**
 * 후보 국면을 연속 확인일수로 안정화한다.
 * @param candidate    오늘 후보 국면
 * @param prevConfirmed 직전 확정 국면
 * @param prevCandidate 직전 후보 국면
 * @param prevStreak    직전까지 누적된 연속일수
 * @param prevStillHolds 오늘 지표 기준으로 직전 확정 국면의 조건이 아직 유효한지
 */
export function stabilize(
  candidate: Regime, prevConfirmed: Regime, prevCandidate: Regime, prevStreak: number, prevStillHolds: boolean,
): StabilizeResult {
  if (candidate === prevConfirmed) return { confirmed: prevConfirmed, streak: 0 };

  const streak = candidate === prevCandidate ? prevStreak + 1 : 1;

  // 대세상승 ↔ 대세하락 직접 전환 금지 (최소 1일 TRANSITION 경유)
  const extremeFlip =
    (prevConfirmed === 'BULL_MAJOR' && candidate === 'BEAR_MAJOR') ||
    (prevConfirmed === 'BEAR_MAJOR' && candidate === 'BULL_MAJOR');
  if (extremeFlip) return { confirmed: 'TRANSITION', streak };

  const need = ORD[candidate] < ORD[prevConfirmed] ? P.confirmDown : P.confirmUp;
  if (streak >= need) return { confirmed: candidate, streak: 0 };

  // 아직 확정 전: 직전 확정이 여전히 유효하면 유지, 아니면 전환구간
  if (prevStillHolds && prevConfirmed !== 'TRANSITION') return { confirmed: prevConfirmed, streak };
  return { confirmed: 'TRANSITION', streak };
}

/** 6국면 → 기존 전략 메타(BULL/SIDEWAYS/BEAR) 3분류 사상 */
export function coarseRegime(r: Regime): CoarseRegime {
  if (r === 'BULL_MAJOR' || r === 'BULL') return 'BULL';
  if (r === 'BEAR' || r === 'BEAR_MAJOR') return 'BEAR';
  return 'SIDEWAYS'; // RANGE, TRANSITION
}

export async function judgeMarket(fetcher: CandleFetcher, symbol: string, market: Market, breadth: number | null = null): Promise<RegimeResult> {
  const candles = await fetcher(symbol, '1d', '2y');
  return classifyFromCandles(candles, market, breadth);
}

export async function judgeBothMarkets(fetcher: CandleFetcher): Promise<{ kospi: RegimeResult; kosdaq: RegimeResult }> {
  const [kospi, kosdaq] = await Promise.all([
    judgeMarket(fetcher, '^KS11', 'KOSPI'),
    judgeMarket(fetcher, '^KQ11', 'KOSDAQ'),
  ]);
  return { kospi, kosdaq };
}

const REGIME_LABEL: Record<Regime, string> = {
  BULL_MAJOR: '대세상승장', BULL: '상승장', RANGE: '횡보장', BEAR: '하락장', BEAR_MAJOR: '대세하락장', TRANSITION: '전환구간',
};
const REGIME_ICON: Record<Regime, string> = {
  BULL_MAJOR: '🚀', BULL: '📈', RANGE: '↔️', BEAR: '📉', BEAR_MAJOR: '🧊', TRANSITION: '🔄',
};
export function regimeLabel(r: Regime): string { return REGIME_LABEL[r] ?? r; }
export function regimeIcon(r: Regime): string { return REGIME_ICON[r] ?? '•'; }
