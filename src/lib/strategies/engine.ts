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

// ── 제네릭 백테스트 ──
const fmt = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
const sideLabel: Record<ExitEvent['side'], string> = {
  SELL_TP1: '1차 익절',
  SELL_TP2: '전량 익절',
  SELL_SL: '손절/청산',
};

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
        logs.push(`[${sideLabel[ev.side]}] ${fmtTime(ev.time)} | 가격 ${fmt(ev.price)} | 손익 ${fmt(ev.pnl)} | ${ev.note}`);
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
