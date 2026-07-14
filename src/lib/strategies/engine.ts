// ===== 전략 공용 계산 엔진 =====
// - 지표 계산 헬퍼(sma/ema/stddev/rolling)
// - 제네릭 백테스트 시뮬레이터 (planEntry + stepOpen 조합)
// - 모의투자용 포지션 관리 (manageOpen)
// - 성과지표 계산
import type { TradeEvent, BacktestResult, BacktestMetrics } from '../types';
import type { StrategyModule, StratRow, OpenPos, ExitEvent } from './types';

// ── 지표 헬퍼 ──
export function smaAt(vals: (number | null)[], period: number, idx: number): number | null {
  if (idx < period - 1) return null;
  let sum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const v = vals[i];
    if (v == null) return null;
    sum += v;
  }
  return sum / period;
}

export function stddevAt(vals: number[], period: number, idx: number): number | null {
  if (idx < period - 1) return null;
  const slice = vals.slice(idx - period + 1, idx + 1);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

/** 지수이동평균 (pandas ewm(span, adjust=False) 방식) */
export function emaArr(vals: number[], span: number): number[] {
  const k = 2 / (span + 1);
  const out: number[] = [];
  let prev = vals[0] ?? 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** [idx-period, idx-1] 구간의 최고값 (현재봉 제외, shift 1) */
export function maxOfPrev(vals: number[], period: number, idx: number): number | null {
  if (idx < period) return null;
  let mx = -Infinity;
  for (let i = idx - period; i <= idx - 1; i++) mx = Math.max(mx, vals[i]);
  return mx;
}

/** [idx-period, idx-1] 구간의 최저값 (현재봉 제외, shift 1) */
export function minOfPrev(vals: number[], period: number, idx: number): number | null {
  if (idx < period) return null;
  let mn = Infinity;
  for (let i = idx - period; i <= idx - 1; i++) mn = Math.min(mn, vals[i]);
  return mn;
}

/** [idx-period, idx-1] 구간의 평균 (현재봉 제외, shift 1) */
export function meanOfPrev(vals: number[], period: number, idx: number): number | null {
  if (idx < period) return null;
  let sum = 0;
  for (let i = idx - period; i <= idx - 1; i++) sum += vals[i];
  return sum / period;
}

// ── Phase 3 공통 지표 (ATR/ADX/CCI/Stochastic/OBV/VWAP/캔들패턴) ──
// 전부 Wilder 방식 또는 표준 산식. null = 워밍업 구간(데이터 부족).

/** True Range 배열 */
function trueRangeArr(highs: number[], lows: number[], closes: number[]): number[] {
  return highs.map((h, i) => {
    if (i === 0) return h - lows[i];
    return Math.max(h - lows[i], Math.abs(h - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  });
}

/** ATR (Wilder 스무딩). idx < period 구간은 null */
export function atrArr(highs: number[], lows: number[], closes: number[], period = 14): (number | null)[] {
  const tr = trueRangeArr(highs, lows, closes);
  const out: (number | null)[] = new Array(tr.length).fill(null);
  let atr = 0;
  for (let i = 0; i < tr.length; i++) {
    if (i < period) { atr += tr[i] / period; if (i === period - 1) out[i] = atr; continue; }
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

/** ADX + DI (Wilder). idx < period*2 근처까지 null 가능 */
export function adxArr(highs: number[], lows: number[], closes: number[], period = 14): { adx: (number | null)[]; plusDI: (number | null)[]; minusDI: (number | null)[] } {
  const n = highs.length;
  const tr = trueRangeArr(highs, lows, closes);
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const smooth = (vals: number[]): number[] => {
    const out = new Array(n).fill(0);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      if (i < period) { acc += vals[i]; if (i === period - 1) out[i] = acc; continue; }
      acc = out[i - 1] - out[i - 1] / period + vals[i];
      out[i] = acc;
    }
    return out;
  };
  const smTR = smooth(tr), smPlus = smooth(plusDM), smMinus = smooth(minusDM);
  const plusDI: (number | null)[] = new Array(n).fill(null);
  const minusDI: (number | null)[] = new Array(n).fill(null);
  const dx: (number | null)[] = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    if (smTR[i] === 0) continue;
    const pDI = 100 * (smPlus[i] / smTR[i]);
    const mDI = 100 * (smMinus[i] / smTR[i]);
    plusDI[i] = pDI; minusDI[i] = mDI;
    const sum = pDI + mDI;
    dx[i] = sum > 0 ? 100 * Math.abs(pDI - mDI) / sum : 0;
  }
  const adx: (number | null)[] = new Array(n).fill(null);
  let adxAcc = 0;
  let started = false;
  let warm = 0;
  for (let i = 0; i < n; i++) {
    const d = dx[i];
    if (d == null) continue;
    if (!started) {
      adxAcc += d; warm++;
      if (warm === period) { adxAcc /= period; adx[i] = adxAcc; started = true; }
      continue;
    }
    adxAcc = (adxAcc * (period - 1) + d) / period;
    adx[i] = adxAcc;
  }
  return { adx, plusDI, minusDI };
}

/** CCI (Commodity Channel Index) */
export function cciArr(highs: number[], lows: number[], closes: number[], period = 20): (number | null)[] {
  const n = highs.length;
  const tp = highs.map((h, i) => (h + lows[i] + closes[i]) / 3);
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const slice = tp.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const meanDev = slice.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    out[i] = meanDev === 0 ? 0 : (tp[i] - mean) / (0.015 * meanDev);
  }
  return out;
}

/** Slow Stochastic: %K(fast)를 kSmooth로 한 번 평활한 것이 Slow %K, 그걸 dPeriod로 평활한 게 %D */
export function slowStochArr(highs: number[], lows: number[], closes: number[], kPeriod = 14, kSmooth = 3, dPeriod = 3): { k: (number | null)[]; d: (number | null)[] } {
  const n = highs.length;
  const fastK: (number | null)[] = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    const hh = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    fastK[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
  }
  const smoothArr = (vals: (number | null)[], period: number): (number | null)[] => {
    const out: (number | null)[] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const window = vals.slice(Math.max(0, i - period + 1), i + 1).filter((v): v is number => v != null);
      if (window.length === period) out[i] = window.reduce((a, b) => a + b, 0) / period;
    }
    return out;
  };
  const slowK = smoothArr(fastK, kSmooth);
  const slowD = smoothArr(slowK, dPeriod);
  return { k: slowK, d: slowD };
}

/** OBV (On Balance Volume) */
export function obvArr(closes: number[], volumes: number[]): number[] {
  const out: number[] = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) out[i] = out[i - 1] + volumes[i];
    else if (closes[i] < closes[i - 1]) out[i] = out[i - 1] - volumes[i];
    else out[i] = out[i - 1];
  }
  return out;
}

/** 당일 누적 VWAP (KST 캘린더 날짜가 바뀌면 리셋). time은 KST 보정된 unix seconds. */
export function vwapArr(times: number[], highs: number[], lows: number[], closes: number[], volumes: number[]): (number | null)[] {
  const dateStr = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const out: (number | null)[] = new Array(times.length).fill(null);
  let curDate = '';
  let cumPV = 0, cumVol = 0;
  for (let i = 0; i < times.length; i++) {
    const d = dateStr(times[i]);
    if (d !== curDate) { curDate = d; cumPV = 0; cumVol = 0; }
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumPV += tp * volumes[i];
    cumVol += volumes[i];
    out[i] = cumVol > 0 ? cumPV / cumVol : closes[i];
  }
  return out;
}

/** 거래량 Z-score (직전 lookback봉 평균/표준편차 기준, 현재봉 제외) */
export function volumeZScoreAt(volumes: number[], lookback: number, idx: number): number | null {
  if (idx < lookback) return null;
  const window = volumes.slice(idx - lookback, idx);
  const mean = window.reduce((a, b) => a + b, 0) / lookback;
  const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / lookback);
  if (sd === 0) return 0;
  return (volumes[idx] - mean) / sd;
}

// ── Phase 3 공통 리스크 필터 (일봉 전략 전용 헬퍼 — planEntry에서 호출) ──
// 15분봉 전략(bnf1/openbrk)은 봉=거래일이 아니므로 이 헬퍼를 쓰지 않고 자체 필터를 둔다.
export interface RiskCheckResult { ok: boolean; reason?: string }

/**
 * 공용 진입 전 리스크 체크 (일봉 rows 기준, i번째 봉에 진입 가정):
 * 1) 손익비(reward/risk) < 1.5 스킵
 * 2) 당일 ATR(14) > 20일 평균 ATR × 2.5 스킵 (변동성 폭주)
 * 3) 당일 시가 갭이 전일 종가 대비 -5%~+5% 밖이면 스킵
 * 4) 최근 5봉 수익률 ≥ +25% 또는 RSI(14) ≥ 80 스킵 (과열)
 */
export function commonRiskCheck(rows: { open: number; high: number; low: number; close: number }[], i: number, entry: number, targetPrice: number, slPrice: number): RiskCheckResult {
  const risk = entry - slPrice;
  const reward = targetPrice - entry;
  if (risk <= 0 || reward <= 0 || reward / risk < 1.5) return { ok: false, reason: '손익비 1.5 미만' };

  if (i > 0) {
    const highs = rows.map((r) => r.high), lows = rows.map((r) => r.low), closes = rows.map((r) => r.close);
    const atr = atrArr(highs, lows, closes, 14);
    const atrNow = atr[i];
    const atrAvg20 = meanOfPrev(atr.map((v) => v ?? 0), 20, i);
    if (atrNow != null && atrAvg20 != null && atrAvg20 > 0 && atrNow > atrAvg20 * 2.5) {
      return { ok: false, reason: 'ATR 변동성 폭주 (평균 대비 2.5배 초과)' };
    }
    const prevClose = closes[i - 1];
    if (prevClose > 0) {
      const gapPct = ((rows[i].open - prevClose) / prevClose) * 100;
      if (gapPct < -5 || gapPct > 5) return { ok: false, reason: `과도한 갭 (${gapPct.toFixed(1)}%)` };
    }
  }
  if (i >= 5) {
    const closes = rows.map((r) => r.close);
    const ret5 = closes[i - 5] > 0 ? ((closes[i] - closes[i - 5]) / closes[i - 5]) * 100 : 0;
    if (ret5 >= 25) return { ok: false, reason: `최근 5봉 급등 (+${ret5.toFixed(1)}%) 과열` };
    const rsi = rsiSimple(closes, 14);
    const rsiNow = rsi[i];
    if (rsiNow != null && rsiNow >= 80) return { ok: false, reason: `RSI 과열 (${rsiNow.toFixed(0)})` };
  }
  return { ok: true };
}

/** 진입 후 경과 일수 (달력일 기준, 봉 주기 무관) */
export function daysElapsed(rowTime: number, openedAtIso: string): number {
  return (rowTime - Math.floor(new Date(openedAtIso).getTime() / 1000)) / 86400;
}

/** ATR 트레일링 스탑: 고가 갱신 시마다 (최고가 - ATR×mult)로 손절선을 끌어올린다 (하향 조정은 하지 않음) */
export function atrTrailSl(currentSl: number, highestSinceEntry: number, atrNow: number | null, mult = 2): number {
  if (atrNow == null) return currentSl;
  const trail = highestSinceEntry - atrNow * mult;
  return Math.max(currentSl, trail);
}

export interface CandlePattern {
  hammer: boolean;          // 아래꼬리 긴 반전형 (몸통 대비 아래꼬리 2배 이상, 윗꼬리 짧음)
  bullishEngulfing: boolean; // 전일 음봉 몸통을 당일 양봉 몸통이 완전히 감쌈
  longLowerWick: boolean;    // 아래꼬리가 몸통의 2배 이상인 양봉/음봉 공통
  bigBull: boolean;          // 장대양봉 (몸통이 당일 변동폭의 60% 이상 + 양봉)
}

/** 단일 캔들(및 전봉)로 판정 가능한 반등형 패턴들. Morning Star(3봉)는 생략(2봉 근사 불가). */
export function detectCandle(c: { open: number; high: number; low: number; close: number }, prev?: { open: number; high: number; low: number; close: number }): CandlePattern {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  const isBull = c.close > c.open;

  const hammer = range > 0 && body > 0 && lowerWick >= body * 2 && upperWick <= body * 0.5;
  const longLowerWick = range > 0 && body > 0 && lowerWick >= body * 2;
  const bigBull = range > 0 && isBull && body >= range * 0.6;
  const bullishEngulfing = !!prev && prev.close < prev.open && isBull &&
    c.close >= prev.open && c.open <= prev.close;

  return { hammer, bullishEngulfing, longLowerWick, bigBull };
}

/** RSI (rolling 평균 방식 — 명세서 스켈레톤과 동일) */
export function rsiSimple(closes: number[], period: number): (number | null)[] {
  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  return closes.map((_, i) => {
    if (i < period) return null;
    let g = 0, l = 0;
    for (let j = i - period + 1; j <= i; j++) { g += gains[j]; l += losses[j]; }
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / l);
  });
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export const starsFromScore = (score: number) => Math.max(1, Math.min(5, Math.round(score / 20)));

/**
 * StratRow 배열(15분봉 등 인트라데이)에서 "전일 대비 등락률(%)"을 계산한다.
 * 바로 이전 봉(15분 전)과 비교하면 값이 항상 0에 가깝게 나오므로,
 * 날짜별로 그룹핑해 가장 최근 완료된 거래일의 마지막 종가와 비교한다.
 */
export function dailyChangePct(rows: StratRow[]): number {
  const last = rows[rows.length - 1];
  if (!last) return 0;
  const dateStr = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const todayStr = dateStr(last.time);
  for (let i = rows.length - 2; i >= 0; i--) {
    if (dateStr(rows[i].time) !== todayStr) {
      const prevClose = rows[i].close;
      return prevClose ? ((last.close - prevClose) / prevClose) * 100 : 0;
    }
  }
  return 0;
}

// ── 제네릭 백테스트 ──
const fmt = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
const sideLabel: Record<ExitEvent['side'], string> = {
  SELL_TP1: '1차 익절',
  SELL_TP2: '전량 익절',
  SELL_SL: '손절/청산',
};

/**
 * side(TP1/TP2/SL)만으로 라벨을 정하면, 추세기반 청산(20일선 이탈 등)이
 * 손실 상태에서 발생해도 '익절'로 표시되는 오류가 생긴다. 실제 pnl 부호로 보정한다.
 */
function exitLabel(side: ExitEvent['side'], pnl: number): string {
  if (pnl < 0 && side !== 'SELL_SL') return '청산(손실)';
  return sideLabel[side];
}

export function simulate(mod: StrategyModule, rows: StratRow[], initialBalance: number): BacktestResult {
  let cash = initialBalance;
  let pos: OpenPos | null = null;
  let entryIdx = 0;
  let roundPnl = 0;
  const trades: TradeEvent[] = [];
  const logs: string[] = [];
  const equity: { time: number; value: number }[] = [];
  const roundResults: number[] = [];
  const holdBars: number[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!pos) {
      if (row.buy) {
        const plan = mod.planEntry(rows, i, cash);
        if (plan && plan.shares > 0 && plan.entry_price > 0) {
          const invest = plan.shares * plan.entry_price;
          cash -= invest;
          pos = {
            symbol: '', name: '', entry_price: plan.entry_price, shares: plan.shares,
            sl: plan.sl, tp1_hit: false, opened_at: new Date(row.time * 1000).toISOString(),
          };
          entryIdx = i;
          roundPnl = 0;
          trades.push({ time: row.time, type: 'BUY', price: plan.entry_price, shares: plan.shares, pnl: 0, note: plan.note });
          logs.push(`[매수] ${fmtTime(row.time)} | 가격 ${fmt(plan.entry_price)} | ${plan.note}`);
        }
      }
    } else {
      const step = mod.stepOpen(pos, row);
      for (const ev of step.events) {
        cash += ev.shares * ev.price;
        roundPnl += ev.pnl;
        const type: TradeEvent['type'] = ev.side === 'SELL_TP1' ? 'TP1' : ev.side === 'SELL_TP2' ? 'TP2' : 'SL';
        trades.push({ time: ev.time, type, price: ev.price, shares: ev.shares, pnl: ev.pnl, note: ev.note });
        logs.push(`[${exitLabel(ev.side, ev.pnl)}] ${fmtTime(ev.time)} | 가격 ${fmt(ev.price)} | 손익 ${fmt(ev.pnl)} | ${ev.note}`);
      }
      if (step.updated == null) {
        roundResults.push(roundPnl);
        holdBars.push(i - entryIdx);
        roundPnl = 0;
        pos = null;
      } else {
        pos = step.updated;
      }
    }
    const eq = cash + (pos ? pos.shares * row.close : 0);
    const prev = equity[equity.length - 1];
    if (prev && prev.time === row.time) prev.value = eq;
    else equity.push({ time: row.time, value: eq });
  }

  const last = rows[rows.length - 1];
  let finalBalance = cash;
  if (pos && last) {
    const proceeds = pos.shares * last.close;
    const pnl = pos.shares * (last.close - pos.entry_price);
    finalBalance += proceeds;
    roundPnl += pnl;
    roundResults.push(roundPnl);
    holdBars.push(rows.length - 1 - entryIdx);
    trades.push({ time: last.time, type: 'EOD', price: last.close, shares: pos.shares, pnl, note: '기말 평가 청산' });
  }

  const metrics = calcMetrics(initialBalance, finalBalance, roundResults, holdBars, equity, rows);
  return { metrics, trades, equityCurve: equity, logs };
}

/** 모의투자: opened_at 이후 봉들을 순차 적용, 발생 이벤트 + 갱신 포지션 반환 (null=전량청산) */
export function manageOpen(mod: StrategyModule, pos: OpenPos, rows: StratRow[]): { events: ExitEvent[]; updated: OpenPos | null } {
  const openedSec = Math.floor(new Date(pos.opened_at).getTime() / 1000);
  let cur: OpenPos | null = pos;
  const events: ExitEvent[] = [];
  for (const row of rows) {
    if (row.time <= openedSec) continue;
    if (!cur) break;
    const step = mod.stepOpen(cur, row);
    for (const ev of step.events) events.push(ev);
    cur = step.updated;
    if (!cur) break;
  }
  return { events, updated: cur };
}

function calcMetrics(
  initial: number, final: number, roundResults: number[], holdBars: number[],
  equityCurve: { time: number; value: number }[], rows: StratRow[],
): BacktestMetrics {
  const totalReturn = ((final - initial) / initial) * 100;
  const wins = roundResults.filter((r) => r > 0).length;
  const winRate = roundResults.length > 0 ? (wins / roundResults.length) * 100 : 0;
  const grossProfit = roundResults.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(roundResults.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  let peak = -Infinity;
  let mdd = 0;
  for (const p of equityCurve) {
    peak = Math.max(peak, p.value);
    mdd = Math.max(mdd, ((peak - p.value) / peak) * 100);
  }

  const rets: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) rets.push(equityCurve[i].value / equityCurve[i - 1].value - 1);
  const meanR = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sdR = rets.length ? Math.sqrt(rets.reduce((a, b) => a + (b - meanR) ** 2, 0) / rets.length) : 0;
  const sharpe = sdR > 0 ? (meanR / sdR) * Math.sqrt(252) : 0;

  let cagr = 0;
  if (rows.length > 1) {
    const years = (rows[rows.length - 1].time - rows[0].time) / (365.25 * 24 * 3600);
    cagr = years > 0.02 ? (Math.pow(final / initial, 1 / years) - 1) * 100 : totalReturn;
  }

  const avgHoldBars = holdBars.length ? holdBars.reduce((a, b) => a + b, 0) / holdBars.length : 0;

  return {
    totalReturn, winRate, mdd,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : 999,
    sharpe, cagr, tradeCount: roundResults.length, avgHoldBars,
    finalBalance: final, initialBalance: initial,
  };
}

export function fmtTime(unix: number): string {
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 진입 수량 계산 (가용현금 × 비중%) */
export function calcShares(cash: number, positionPct: number, price: number): number {
  if (price <= 0) return 0;
  return (cash * (positionPct / 100)) / price;
}
