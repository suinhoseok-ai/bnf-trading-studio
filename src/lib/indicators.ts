// ===== BNF 전략1 지표 산식 (설계 명세서 3.1 ~ 3.3 구현) =====
import type { Candle, IndicatorRow } from './types';

function sma(values: (number | null)[], period: number, idx: number): number | null {
  if (idx < period - 1) return null;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const v = values[i];
    if (v == null) return null;
    sum += v;
  }
  return sum / period;
}

function stddev(values: number[], period: number, idx: number): number | null {
  if (idx < period - 1) return null;
  const slice = values.slice(idx - period + 1, idx + 1);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * 볼린저 밴드(20, 2σ), 밴드폭, 수렴(Squeeze) 판별, BNF1 매수 신호 계산
 *
 * 수렴 판단 식 (명세서 3.2):
 *   is_squeezed = (BW < SMA(BW,20)) AND (BW <= Percentile(BW_100, 25))
 * 매수 조건 (명세서 3.3):
 *   is_squeezed == true AND 종가 < 하단밴드
 *   단, 밴드폭이 급격히 확장(발산)되는 구간은 진입 차단
 */
export function calcIndicators(
  candles: Candle[],
  opts = { period: 20, stddev: 2, bwLookback: 100, bwPercentile: 25 },
): IndicatorRow[] {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const rows: IndicatorRow[] = [];
  const bandwidths: (number | null)[] = [];

  // RSI(14) 준비 (스캐너 점수용)
  const rsiPeriod = 14;
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < candles.length; i++) {
    const ma = sma(closes, opts.period, i);
    const sd = stddev(closes, opts.period, i);
    const upper = ma != null && sd != null ? ma + opts.stddev * sd : null;
    const lower = ma != null && sd != null ? ma - opts.stddev * sd : null;
    const bw = ma != null && upper != null && lower != null && ma !== 0 ? (upper - lower) / ma : null;
    bandwidths.push(bw);

    const bwMa20 = sma(bandwidths, 20, i);

    let bwPct25: number | null = null;
    if (i >= opts.bwLookback - 1) {
      const window = bandwidths.slice(i - opts.bwLookback + 1, i + 1).filter((v): v is number => v != null);
      if (window.length === opts.bwLookback) {
        bwPct25 = percentile([...window].sort((a, b) => a - b), opts.bwPercentile);
      }
    }

    const isSqueezed = bw != null && bwMa20 != null && bwPct25 != null && bw < bwMa20 && bw <= bwPct25;

    // 발산(급격한 밴드 확장) 필터: 직전 봉 대비 밴드폭 10% 이상 연속 확대 시 진입 금지
    const prevBw = i > 0 ? bandwidths[i - 1] : null;
    const prev2Bw = i > 1 ? bandwidths[i - 2] : null;
    const expanding =
      bw != null && prevBw != null && prev2Bw != null && bw > prevBw * 1.1 && prevBw > prev2Bw;

    const buySignal =
      isSqueezed && !expanding && lower != null && candles[i].close < lower;

    // RSI(14) Wilder 방식
    let rsi: number | null = null;
    if (i > 0) {
      const change = closes[i] - closes[i - 1];
      const gain = Math.max(change, 0);
      const loss = Math.max(-change, 0);
      if (i <= rsiPeriod) {
        avgGain += gain / rsiPeriod;
        avgLoss += loss / rsiPeriod;
        if (i === rsiPeriod) {
          rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        }
      } else {
        avgGain = (avgGain * (rsiPeriod - 1) + gain) / rsiPeriod;
        avgLoss = (avgLoss * (rsiPeriod - 1) + loss) / rsiPeriod;
        rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }

    rows.push({
      ...candles[i],
      ma20: ma,
      std: sd,
      upperBand: upper,
      lowerBand: lower,
      bandwidth: bw,
      bwMa20,
      bwPct25,
      isSqueezed,
      buySignal,
      rsi14: rsi,
      volMa20: sma(volumes, 20, i),
    });
  }
  return rows;
}

/** 현재 밴드폭이 최근 N봉 중 몇 백분위인지 (낮을수록 수렴 강함) */
export function bwPercentRank(rows: IndicatorRow[], lookback = 100): number | null {
  const i = rows.length - 1;
  if (i < 0) return null;
  const cur = rows[i].bandwidth;
  if (cur == null) return null;
  const window = rows
    .slice(Math.max(0, i - lookback + 1), i + 1)
    .map((r) => r.bandwidth)
    .filter((v): v is number => v != null);
  if (window.length < 20) return null;
  const below = window.filter((v) => v <= cur).length;
  return Math.round((below / window.length) * 100);
}
