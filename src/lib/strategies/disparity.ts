// ===== 전략7: (하락) 낙폭과대 반등 (Deep Drop Rebound) — 이격도 낙주 전략 통합 =====
// 5일 -15%↑/10일 -20%↑ 급락 + (종가≤MA60×0.80 또는 종가/EMA25≤0.85) + RSI 20~35 + 볼린저 재진입
// + CCI -200 찍고 -100 회복 + Slow Stoch 20 이하 골든크로스 시 매수.
import type { Candle } from '../types';
import type { StrategyModule, StratRow, OpenPos, ExitEvent, EntryPlan, StratScan } from './types';
import { calcShares, starsFromScore, emaArr, smaAt, stddevAt, rsiSimple, cciArr, slowStochArr, daysElapsed, dailyChangePct } from './engine';

const PARAMS = {
  drop5: 15, drop10: 20, ma60Ratio: 0.80, ema25Ratio: 0.85,
  rsiLo: 20, rsiHi: 35, bbPeriod: 20, bbMult: 2, cciFloor: -200, cciRecover: -100, stochMax: 20,
  slPct: 3, tp1: 5, tp2: 8, tp3: 12, maxDays: 5, positionPct: 15,
};

function compute(candles: Candle[]): StratRow[] {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const ema25 = emaArr(closes, 25);
  const ma20 = closes.map((_, i) => smaAt(closes, 20, i));
  const ma60 = closes.map((_, i) => smaAt(closes, 60, i));
  const bbMa = closes.map((_, i) => smaAt(closes, PARAMS.bbPeriod, i));
  const bbSd = closes.map((_, i) => stddevAt(closes, PARAMS.bbPeriod, i));
  const bbLower = bbMa.map((m, i) => (m != null && bbSd[i] != null ? m - PARAMS.bbMult * (bbSd[i] as number) : null));
  const rsi = rsiSimple(closes, 14);
  const cci = cciArr(highs, lows, closes, 20);
  const { k: stochK, d: stochD } = slowStochArr(highs, lows, closes, 14, 3, 3);

  return candles.map((c, i) => {
    const ret5 = i >= 5 && closes[i - 5] > 0 ? ((c.close - closes[i - 5]) / closes[i - 5]) * 100 : null;
    const ret10 = i >= 10 && closes[i - 10] > 0 ? ((c.close - closes[i - 10]) / closes[i - 10]) * 100 : null;
    const dropOk = (ret5 != null && ret5 <= -PARAMS.drop5) || (ret10 != null && ret10 <= -PARAMS.drop10);

    const deepBelowMa60 = ma60[i] != null && c.close <= (ma60[i] as number) * PARAMS.ma60Ratio;
    const deepBelowEma25 = ema25[i] !== 0 && c.close / ema25[i] <= PARAMS.ema25Ratio;
    const disparityOk = deepBelowMa60 || deepBelowEma25;

    const rsiOk = rsi[i] != null && (rsi[i] as number) >= PARAMS.rsiLo && (rsi[i] as number) <= PARAMS.rsiHi;

    const brokeLowerRecently = bbLower[i] != null && (() => {
      for (let j = Math.max(0, i - 5); j < i; j++) if (bbLower[j] != null && candles[j].close < (bbLower[j] as number)) return true;
      return false;
    })();
    const reenteredBand = bbLower[i] != null && c.close >= (bbLower[i] as number);

    const touchedCciFloor = (() => {
      for (let j = Math.max(0, i - 10); j <= i; j++) if (cci[j] != null && (cci[j] as number) <= PARAMS.cciFloor) return true;
      return false;
    })();
    const cciRecovered = cci[i] != null && (cci[i] as number) >= PARAMS.cciRecover;

    const k = stochK[i], d = stochD[i], pk = i > 0 ? stochK[i - 1] : null, pd = i > 0 ? stochD[i - 1] : null;
    const stochGC = k != null && d != null && pk != null && pd != null && k > d && pk <= pd && k <= PARAMS.stochMax + 10;

    const buy = !!(dropOk && disparityOk && rsiOk && brokeLowerRecently && reenteredBand && touchedCciFloor && cciRecovered && stochGC);
    const exit = ma20[i] != null && c.close > (ma20[i] as number);

    return {
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      buy, exit,
      lines: { ema25: ema25[i], ma20: ma20[i], ma60: ma60[i] },
      m: {
        ret5, ret10, disparityOk: disparityOk ? 1 : 0, rsi: rsi[i], cci: cci[i], stochK: k,
        bbReentry: brokeLowerRecently && reenteredBand ? 1 : 0, cciRecovered: touchedCciFloor && cciRecovered ? 1 : 0, ma20: ma20[i],
      },
    };
  });
}

function planEntry(rows: StratRow[], i: number, cash: number): EntryPlan | null {
  const row = rows[i];
  const entry = row.close;
  const sl = Math.max(row.low, entry * (1 - PARAMS.slPct / 100));
  if (sl >= entry) return null;
  const shares = calcShares(cash, PARAMS.positionPct, entry);
  if (shares <= 0) return null;
  return { entry_price: entry, shares, sl, note: `낙폭과대 반등 매수 · 손절가 ${Math.round(sl).toLocaleString('ko-KR')}` };
}

function stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null } {
  const events: ExitEvent[] = [];
  let { shares, tp1_hit } = pos;
  const entry = pos.entry_price;
  const ma20 = row.lines.ma20;

  if (row.close <= pos.sl) {
    events.push({ side: 'SELL_SL', price: row.close, shares, pnl: shares * (row.close - entry), note: '손절 청산', time: row.time });
    return { events, updated: null };
  }
  const profitPct = ((row.close - entry) / entry) * 100;
  if (!tp1_hit && profitPct >= PARAMS.tp1) {
    const half = shares * 0.3;
    events.push({ side: 'SELL_TP1', price: row.close, shares: half, pnl: half * (row.close - entry), note: `+${PARAMS.tp1}% 30% 익절`, time: row.time });
    shares -= half;
    tp1_hit = true;
  }
  if (tp1_hit && profitPct >= PARAMS.tp2 && shares > 0) {
    const chunk = shares * (0.3 / 0.7);
    const sell = Math.min(shares, chunk);
    events.push({ side: 'SELL_TP1', price: row.close, shares: sell, pnl: sell * (row.close - entry), note: `+${PARAMS.tp2}% 추가 익절`, time: row.time });
    shares -= sell;
  }
  const nearMa20 = ma20 != null && row.close >= ma20 * 0.99;
  if (shares > 0 && (profitPct >= PARAMS.tp3 || nearMa20)) {
    events.push({ side: 'SELL_TP2', price: row.close, shares, pnl: shares * (row.close - entry), note: nearMa20 ? 'MA20 접근 전량 청산' : `+${PARAMS.tp3}% 목표 도달 전량 청산`, time: row.time });
    return { events, updated: null };
  }
  const days = daysElapsed(row.time, pos.opened_at);
  if (shares > 0 && days >= PARAMS.maxDays) {
    events.push({ side: 'SELL_TP2', price: row.close, shares, pnl: shares * (row.close - entry), note: '5거래일 경과 전량 청산', time: row.time });
    return { events, updated: null };
  }
  if (shares <= 0) return { events, updated: null };
  return { events, updated: { ...pos, shares, tp1_hit } };
}

function scan(symbol: string, name: string, rows: StratRow[]): StratScan {
  const last = rows[rows.length - 1];
  const price = last?.close ?? 0;
  const changePct = dailyChangePct(rows);
  const ret5 = last?.m.ret5 ?? null;
  const dropOk = last?.m.ret5 != null && (last.m.ret5 as number) <= -PARAMS.drop5;
  const disparityOk = last?.m.disparityOk === 1;
  const rsi = last?.m.rsi ?? null;
  const rsiOk = rsi != null && rsi >= PARAMS.rsiLo && rsi <= PARAMS.rsiHi;
  const cciRecovered = last?.m.cciRecovered === 1;
  const bbReentry = last?.m.bbReentry === 1;

  const conditions = [
    { label: `5일 -${PARAMS.drop5}%/10일 -${PARAMS.drop10}% 낙폭과대`, met: dropOk, pts: 20 },
    { label: 'MA60×0.8 또는 EMA25×0.85 이하 이격', met: disparityOk, pts: 20 },
    { label: `RSI(14) ${PARAMS.rsiLo}~${PARAMS.rsiHi}`, met: rsiOk, pts: 15 },
    { label: '볼린저 하단 이탈 후 재진입', met: bbReentry, pts: 15 },
    { label: 'CCI -200 찍고 -100 회복', met: cciRecovered, pts: 15 },
    { label: 'Slow Stoch 골든크로스', met: last?.buy ?? false, pts: 15 },
  ];
  const score = conditions.reduce((a, c) => a + (c.met ? c.pts : 0), 0);

  return {
    symbol, name, price, changePct,
    buy: last?.buy ?? false,
    exit: last?.exit ?? false,
    score, stars: starsFromScore(score),
    cols: [
      { value: ret5 != null ? ret5.toFixed(1) + '%' : '-', tone: dropOk ? 'accent' : 'default' },
      { value: rsi != null ? rsi.toFixed(0) : '-', tone: rsiOk ? 'accent' : 'default' },
      { value: cciRecovered ? '회복' : '-', tone: cciRecovered ? 'up' : 'muted' },
    ],
    conditions,
  };
}

export const disparity: StrategyModule = {
  code: 'disparity',
  name: '전략7 · (하락) 낙폭과대 반등',
  short: '5일 -15%/10일 -20% 낙폭과대 + MA60×0.8 또는 EMA25×0.85 이하 이격 + RSI 20~35 + 볼린저 재진입 + CCI -200→-100 회복 + Slow Stoch 골든크로스 시 매수. 분할익절(+5%/+8%) 후 +12% 또는 MA20 접근 시 전량, 5거래일 시간청산.',
  interval: '1d',
  range: '2y',
  positionPct: PARAMS.positionPct,
  params: PARAMS,
  regime: 'BEAR', risk: 3,
  lineStyles: [
    { key: 'ema25', color: '#f59e0b', width: 2, label: 'EMA25' },
    { key: 'ma20', color: '#22c55e', width: 1, label: 'MA20' },
    { key: 'ma60', color: '#8b5cf6', width: 1, label: 'MA60' },
  ],
  colHeaders: ['5일등락', 'RSI', 'CCI회복'],
  rules: [
    { tag: '①', color: 'text-accent', title: '진입', body: '5일 -15% 또는 10일 -20% 이상 낙폭과대 + MA60×0.8 또는 EMA25×0.85 이하로 깊게 이격 + RSI(14) 20~35 + 볼린저 하단 이탈 후 재진입 + CCI -200 찍고 -100 회복 + Slow Stochastic 골든크로스 시 가용 현금 15% 매수.' },
    { tag: '②', color: 'text-amber-400', title: '손절', body: 'max(반등봉 저가, 진입가 -3%) 중 타이트한 값.' },
    { tag: '③', color: 'text-profit', title: '분할 익절', body: '+5% 도달 시 30%, +8% 도달 시 추가 익절.' },
    { tag: '④', color: 'text-slate-300', title: '최종 청산', body: '+12% 목표 도달 또는 MA20 근접(-1% 이내) 시 잔여 전량 청산, 5거래일 경과 시 무조건 전량 청산.' },
  ],
  compute, scan, planEntry, stepOpen,
};
