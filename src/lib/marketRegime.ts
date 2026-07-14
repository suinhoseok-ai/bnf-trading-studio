// ===== 시장국면(상승/횡보/하락) 판별 엔진 =====
// KOSPI(^KS11)/KOSDAQ(^KQ11) 일봉 1년치로 판정. 서버(regime.mts)와 클라이언트(대시보드 폴백) 공용.
// 캔들 fetcher를 주입받아 사용 — 서버는 fetchCandlesServer(Yahoo 직접), 클라이언트는 fetchCandles(/api/yahoo 프록시).
import type { Candle } from './types';
import { smaAt, meanOfPrev, atrArr, adxArr } from './strategies/engine';

export type CandleFetcher = (symbol: string, interval: string, range: string) => Promise<Candle[]>;

export type Regime = 'BULL' | 'SIDEWAYS' | 'BEAR';

export interface RegimeEvidence { label: string; met: boolean; value: string }
export interface RegimeResult {
  market: 'KOSPI' | 'KOSDAQ';
  regime: Regime;
  score: { bull: number; sideways: number; bear: number };
  evidence: RegimeEvidence[];
  price: number;
}

const pct = (n: number) => `${n.toFixed(2)}%`;

/**
 * 캔들 배열(일봉)로 국면을 판정한다.
 * prevRegime을 주면 히스테리시스 적용: 국면 전환에는 새 국면의 충족 개수가
 * 기준보다 1개 더 필요하다 (경계에서 매일 국면이 바뀌는 노이즈 방지).
 */
export function judgeFromCandles(candles: Candle[], market: 'KOSPI' | 'KOSDAQ', prevRegime?: Regime): RegimeResult {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const i = candles.length - 1;

  const ma5 = smaAt(closes, 5, i);
  const ma20 = smaAt(closes, 20, i);
  const ma60 = smaAt(closes, 60, i);
  const ma120 = smaAt(closes, 120, i);
  const ma20Prev5 = i >= 5 ? smaAt(closes, 20, i - 5) : null;
  const { adx } = adxArr(highs, lows, closes, 14);
  const adxNow = adx[i];
  const atr = atrArr(highs, lows, closes, 14);
  const atrNow = atr[i];
  const atrPrev = i >= 20 ? atr[i - 20] : null;
  const close = closes[i];
  const volAvg20 = meanOfPrev(volumes, 20, i);
  const volRatio = volAvg20 && volAvg20 > 0 ? volumes[i] / volAvg20 : null;

  const window20High = i >= 19 ? Math.max(...highs.slice(i - 19, i + 1)) : null;
  const window20Low = i >= 19 ? Math.min(...lows.slice(i - 19, i + 1)) : null;
  const rangePct = window20High != null && window20Low != null && window20Low > 0
    ? ((window20High - window20Low) / window20Low) * 100 : null;
  const nearHigh20 = window20High != null && window20High > 0 ? ((window20High - close) / window20High) * 100 : null; // 작을수록 신고가 근접
  const nearLow20 = window20Low != null && window20Low > 0 ? ((close - window20Low) / window20Low) * 100 : null; // 작을수록 신저가 근접
  const ma20SlopePctPerDay = ma20 != null && ma20Prev5 != null && ma20Prev5 !== 0
    ? ((ma20 - ma20Prev5) / ma20Prev5 / 5) * 100 : null;

  // ── 상승장 조건 (6중 4↑) ──
  const bullConds: RegimeEvidence[] = [
    { label: 'Close > MA20', met: ma20 != null && close > ma20, value: ma20 != null ? String(Math.round(ma20)) : '-' },
    { label: 'MA20 > MA60', met: ma20 != null && ma60 != null && ma20 > ma60, value: '-' },
    { label: 'MA60 > MA120', met: ma60 != null && ma120 != null && ma60 > ma120, value: '-' },
    { label: 'ADX > 25', met: adxNow != null && adxNow > 25, value: adxNow != null ? adxNow.toFixed(1) : '-' },
    { label: '20일 신고가 근접(-2% 이내)', met: nearHigh20 != null && nearHigh20 <= 2, value: nearHigh20 != null ? pct(nearHigh20) : '-' },
    { label: '거래량 > 평균 1.2배', met: volRatio != null && volRatio > 1.2, value: volRatio != null ? volRatio.toFixed(2) + '배' : '-' },
  ];
  // ── 횡보장 조건 (5중 3↑) ──
  const sidewaysConds: RegimeEvidence[] = [
    { label: 'MA20 수평 (±0.15%/일)', met: ma20SlopePctPerDay != null && Math.abs(ma20SlopePctPerDay) <= 0.15, value: ma20SlopePctPerDay != null ? pct(ma20SlopePctPerDay) + '/일' : '-' },
    { label: 'ADX < 20', met: adxNow != null && adxNow < 20, value: adxNow != null ? adxNow.toFixed(1) : '-' },
    { label: '20일 변동폭 ≤ 15%', met: rangePct != null && rangePct <= 15, value: rangePct != null ? pct(rangePct) : '-' },
    { label: 'ATR 감소 (20봉 전 대비)', met: atrNow != null && atrPrev != null && atrNow < atrPrev, value: atrNow != null ? String(Math.round(atrNow)) : '-' },
    { label: '거래량 평균 이하', met: volRatio != null && volRatio <= 1.0, value: volRatio != null ? volRatio.toFixed(2) + '배' : '-' },
  ];
  // ── 하락장 조건 (6중 4↑) ──
  const bearConds: RegimeEvidence[] = [
    { label: 'Close < MA20', met: ma20 != null && close < ma20, value: ma20 != null ? String(Math.round(ma20)) : '-' },
    { label: 'MA20 < MA60', met: ma20 != null && ma60 != null && ma20 < ma60, value: '-' },
    { label: 'MA60 < MA120', met: ma60 != null && ma120 != null && ma60 < ma120, value: '-' },
    { label: 'ADX > 25', met: adxNow != null && adxNow > 25, value: adxNow != null ? adxNow.toFixed(1) : '-' },
    { label: '20일 신저가 근접(+2% 이내)', met: nearLow20 != null && nearLow20 <= 2, value: nearLow20 != null ? pct(nearLow20) : '-' },
    { label: '거래량 > 평균 1.2배', met: volRatio != null && volRatio > 1.2, value: volRatio != null ? volRatio.toFixed(2) + '배' : '-' },
  ];

  const bullN = bullConds.filter((c) => c.met).length;
  const sidewaysN = sidewaysConds.filter((c) => c.met).length;
  const bearN = bearConds.filter((c) => c.met).length;

  const bullHit = bullN >= (prevRegime && prevRegime !== 'BULL' ? 5 : 4);
  const bearHit = bearN >= (prevRegime && prevRegime !== 'BEAR' ? 5 : 4);
  const sidewaysHit = sidewaysN >= (prevRegime && prevRegime !== 'SIDEWAYS' ? 4 : 3);

  // 우선순위: BEAR > BULL > SIDEWAYS. 전부 미충족 시 SIDEWAYS 폴백.
  let regime: Regime;
  let evidence: RegimeEvidence[];
  if (bearHit) { regime = 'BEAR'; evidence = bearConds; }
  else if (bullHit) { regime = 'BULL'; evidence = bullConds; }
  else if (sidewaysHit) { regime = 'SIDEWAYS'; evidence = sidewaysConds; }
  else { regime = 'SIDEWAYS'; evidence = sidewaysConds; }

  return {
    market, regime,
    score: { bull: bullN, sideways: sidewaysN, bear: bearN },
    evidence,
    price: close,
  };
}

export async function judgeMarket(fetcher: CandleFetcher, symbol: string, market: 'KOSPI' | 'KOSDAQ', prevRegime?: Regime): Promise<RegimeResult> {
  const candles = await fetcher(symbol, '1d', '1y');
  return judgeFromCandles(candles, market, prevRegime);
}

export async function judgeBothMarkets(fetcher: CandleFetcher, prevKospi?: Regime, prevKosdaq?: Regime): Promise<{ kospi: RegimeResult; kosdaq: RegimeResult }> {
  const [kospi, kosdaq] = await Promise.all([
    judgeMarket(fetcher, '^KS11', 'KOSPI', prevKospi),
    judgeMarket(fetcher, '^KQ11', 'KOSDAQ', prevKosdaq),
  ]);
  return { kospi, kosdaq };
}

const REGIME_LABEL: Record<Regime, string> = { BULL: '상승장', SIDEWAYS: '횡보장', BEAR: '하락장' };
const REGIME_ICON: Record<Regime, string> = { BULL: '📈', SIDEWAYS: '↔️', BEAR: '📉' };
export function regimeLabel(r: Regime): string { return REGIME_LABEL[r]; }
export function regimeIcon(r: Regime): string { return REGIME_ICON[r]; }
