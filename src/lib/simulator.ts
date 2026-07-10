// ===== 가상 시뮬레이터 (설계 명세서 3.4 청산 로직 + 4장 VirtualSimulator 구현) =====
// - 진입: 가용 현금의 10% 매수
// - 초기 손절: Entry - (UB_entry - Entry) / 2  (1:2 손익비)
// - 1차 익절: 중심선 도달 시 50% 청산 → 손절가 본절(Entry) 이동
// - 2차 익절: 상단밴드 도달 시 잔량 전량 청산
import type { IndicatorRow, TradeEvent, BacktestResult, BacktestMetrics } from './types';

interface Position {
  status: 'NONE' | 'LONG';
  entryPrice: number;
  shares: number;
  sl: number;
  tp1Hit: boolean;
  entryIndex: number;
  costBasis: number; // 잔여 물량의 취득원가 (PnL 계산용)
}

export interface SimulatorOptions {
  initialBalance: number;
  positionPct: number; // 진입 비중 (% of cash)
  riskReward: number; // 손익비 (2 = 1:2)
}

const DEFAULT_OPTS: SimulatorOptions = { initialBalance: 10_000_000, positionPct: 10, riskReward: 2 };

export function runBacktest(rows: IndicatorRow[], options?: Partial<SimulatorOptions>): BacktestResult {
  const opts = { ...DEFAULT_OPTS, ...options };
  let cash = opts.initialBalance;
  let pos: Position = { status: 'NONE', entryPrice: 0, shares: 0, sl: 0, tp1Hit: false, entryIndex: 0, costBasis: 0 };

  const trades: TradeEvent[] = [];
  const logs: string[] = [];
  const equityCurve: { time: number; value: number }[] = [];

  // 완결된 라운드트립 단위 집계 (승률/PF 계산)
  let roundPnl = 0;
  const roundResults: number[] = [];
  const holdBars: number[] = [];

  const fmt = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });

  const closeRound = (i: number) => {
    roundResults.push(roundPnl);
    holdBars.push(i - pos.entryIndex);
    roundPnl = 0;
    pos = { status: 'NONE', entryPrice: 0, shares: 0, sl: 0, tp1Hit: false, entryIndex: 0, costBasis: 0 };
  };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    if (pos.status === 'NONE') {
      // ── 매수 진입 판단 ──
      if (row.buySignal && row.upperBand != null) {
        const investAmount = cash * (opts.positionPct / 100);
        if (investAmount > 0) {
          const entry = row.close;
          const shares = investAmount / entry;
          const targetDist = row.upperBand - entry;
          const sl = entry - targetDist / opts.riskReward;
          pos = { status: 'LONG', entryPrice: entry, shares, sl, tp1Hit: false, entryIndex: i, costBasis: investAmount };
          cash -= investAmount;
          roundPnl = 0;
          trades.push({ time: row.time, type: 'BUY', price: entry, shares, pnl: 0, note: `손절가 ${fmt(sl)}` });
          logs.push(`[매수] ${fmtTime(row.time)} | 가격 ${fmt(entry)} | 손절가 ${fmt(sl)} 설정 (1:${opts.riskReward} 손익비)`);
        }
      }
    } else if (pos.status === 'LONG') {
      // ── 1. 손절 조건 (저가가 손절가 이탈) ──
      if (row.low <= pos.sl) {
        const proceeds = pos.shares * pos.sl;
        const pnl = proceeds - pos.costBasis;
        cash += proceeds;
        roundPnl += pnl;
        const type = pos.tp1Hit ? 'SL' : 'SL';
        trades.push({ time: row.time, type, price: pos.sl, shares: pos.shares, pnl, note: pos.tp1Hit ? '본절 청산' : '손절 청산' });
        logs.push(`[${pos.tp1Hit ? '본절' : '손절'} 매도] ${fmtTime(row.time)} | 가격 ${fmt(pos.sl)} | 손익 ${fmt(pnl)}`);
        closeRound(i);
        recordEquity(equityCurve, row, cash, pos);
        continue;
      }
      // ── 2. 1차 익절 (중심선 도달 → 50% 청산 + 본절 이동) ──
      if (!pos.tp1Hit && row.ma20 != null && row.high >= row.ma20) {
        const half = pos.shares * 0.5;
        const proceeds = half * row.ma20;
        const halfCost = pos.costBasis * 0.5;
        const pnl = proceeds - halfCost;
        cash += proceeds;
        roundPnl += pnl;
        pos.shares -= half;
        pos.costBasis -= halfCost;
        pos.tp1Hit = true;
        pos.sl = pos.entryPrice; // 손절가 → 본절가 고정 (손실 가능성 0%)
        trades.push({ time: row.time, type: 'TP1', price: row.ma20, shares: half, pnl, note: '중심선 50% 익절, 손절가 본절 이동' });
        logs.push(`[1차 익절 50%] ${fmtTime(row.time)} | 가격 ${fmt(row.ma20)} | 손절가 본절(${fmt(pos.entryPrice)}) 이동`);
      }
      // ── 3. 2차 익절 (상단밴드 도달 → 전량 청산) ──
      if (pos.status === 'LONG' && pos.tp1Hit && row.upperBand != null && row.high >= row.upperBand) {
        const proceeds = pos.shares * row.upperBand;
        const pnl = proceeds - pos.costBasis;
        cash += proceeds;
        roundPnl += pnl;
        trades.push({ time: row.time, type: 'TP2', price: row.upperBand, shares: pos.shares, pnl, note: '상단밴드 전량 익절' });
        logs.push(`[2차 전량 익절] ${fmtTime(row.time)} | 가격 ${fmt(row.upperBand)} | 손익 ${fmt(pnl)}`);
        closeRound(i);
      }
    }

    recordEquity(equityCurve, row, cash, pos);
  }

  // 미청산 포지션 평가 (기말 종가 기준)
  const last = rows[rows.length - 1];
  let finalBalance = cash;
  if (pos.status === 'LONG' && last) {
    const proceeds = pos.shares * last.close;
    const pnl = proceeds - pos.costBasis;
    finalBalance += proceeds;
    roundPnl += pnl;
    roundResults.push(roundPnl);
    holdBars.push(rows.length - 1 - pos.entryIndex);
    trades.push({ time: last.time, type: 'EOD', price: last.close, shares: pos.shares, pnl, note: '기말 평가 청산' });
  }

  const metrics = calcMetrics(opts.initialBalance, finalBalance, roundResults, holdBars, equityCurve, rows);
  return { metrics, trades, equityCurve, logs };
}

function recordEquity(
  curve: { time: number; value: number }[],
  row: IndicatorRow,
  cash: number,
  pos: Position,
) {
  const equity = cash + (pos.status === 'LONG' ? pos.shares * row.close : 0);
  const prev = curve[curve.length - 1];
  if (prev && prev.time === row.time) prev.value = equity;
  else curve.push({ time: row.time, value: equity });
}

// ===== 성과 지표 (명세서 5장: 총수익률/승률/MDD/PF + Sharpe/CAGR/보유기간) =====
function calcMetrics(
  initial: number,
  final: number,
  roundResults: number[],
  holdBars: number[],
  equityCurve: { time: number; value: number }[],
  rows: IndicatorRow[],
): BacktestMetrics {
  const totalReturn = ((final - initial) / initial) * 100;
  const wins = roundResults.filter((r) => r > 0).length;
  const winRate = roundResults.length > 0 ? (wins / roundResults.length) * 100 : 0;

  const grossProfit = roundResults.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(roundResults.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // MDD
  let peak = -Infinity;
  let mdd = 0;
  for (const p of equityCurve) {
    peak = Math.max(peak, p.value);
    mdd = Math.max(mdd, ((peak - p.value) / peak) * 100);
  }

  // Sharpe (봉 단위 수익률 기반, 무위험수익률 0 가정)
  const rets: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    rets.push(equityCurve[i].value / equityCurve[i - 1].value - 1);
  }
  const meanR = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sdR = rets.length
    ? Math.sqrt(rets.reduce((a, b) => a + (b - meanR) ** 2, 0) / rets.length)
    : 0;
  const sharpe = sdR > 0 ? (meanR / sdR) * Math.sqrt(252) : 0;

  // CAGR
  let cagr = 0;
  if (rows.length > 1) {
    const years = (rows[rows.length - 1].time - rows[0].time) / (365.25 * 24 * 3600);
    if (years > 0.02) cagr = (Math.pow(final / initial, 1 / years) - 1) * 100;
    else cagr = totalReturn;
  }

  const avgHoldBars = holdBars.length ? holdBars.reduce((a, b) => a + b, 0) / holdBars.length : 0;

  return {
    totalReturn,
    winRate,
    mdd,
    profitFactor: Number.isFinite(profitFactor) ? profitFactor : 999,
    sharpe,
    cagr,
    tradeCount: roundResults.length,
    avgHoldBars,
    finalBalance: final,
    initialBalance: initial,
  };
}

function fmtTime(unix: number): string {
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
