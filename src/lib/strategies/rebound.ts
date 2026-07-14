// ===== 전략6: (하락) 과매도 반등 (Oversold Rebound) =====
// 5일 -8%↑/10일 -12%↑ 급락 + RSI(14)≤25 + 볼린저 하단 이탈 후 재진입 + 거래량 Z≥2.5(투매) + 반등캔들.
// 반등봉 저가 이탈/-2.5% 손절, 분할익절(+2.5%/+5%) 후 MA5 이탈 잔량 청산, 2거래일 무조건 전량 시간청산.
import type { Candle } from '../types';
import type { StrategyModule, StratRow, OpenPos, ExitEvent, EntryPlan, StratScan } from './types';
import { calcShares, starsFromScore, smaAt, stddevAt, rsiSimple, volumeZScoreAt, detectCandle, daysElapsed, dailyChangePct } from './engine';

const PARAMS = {
  drop5: 8, drop10: 12, rsiMax: 25, bbPeriod: 20, bbMult: 2, volZMin: 2.5,
  gapMaxDown: 5, slPct: 2.5, tp1: 2.5, tp2: 5, maxDays: 2, positionPct: 10,
};

function compute(candles: Candle[]): StratRow[] {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const ma5 = closes.map((_, i) => smaAt(closes, 5, i));
  const bbMa = closes.map((_, i) => smaAt(closes, PARAMS.bbPeriod, i));
  const bbSd = closes.map((_, i) => stddevAt(closes, PARAMS.bbPeriod, i));
  const bbLower = bbMa.map((m, i) => (m != null && bbSd[i] != null ? m - PARAMS.bbMult * (bbSd[i] as number) : null));
  const rsi = rsiSimple(closes, 14);

  return candles.map((c, i) => {
    const ret5 = i >= 5 && closes[i - 5] > 0 ? ((c.close - closes[i - 5]) / closes[i - 5]) * 100 : null;
    const ret10 = i >= 10 && closes[i - 10] > 0 ? ((c.close - closes[i - 10]) / closes[i - 10]) * 100 : null;
    const dropOk = (ret5 != null && ret5 <= -PARAMS.drop5) || (ret10 != null && ret10 <= -PARAMS.drop10);

    const rsiOk = rsi[i] != null && (rsi[i] as number) <= PARAMS.rsiMax;

    // 볼린저 하단 이탈 후 재진입: 직전 3봉 내 하단 이탈이 있었고, 당일은 밴드 안으로 복귀
    const brokeLowerRecently = bbLower[i] != null && (() => {
      for (let j = Math.max(0, i - 3); j < i; j++) if (bbLower[j] != null && candles[j].close < (bbLower[j] as number)) return true;
      return false;
    })();
    const reenteredBand = bbLower[i] != null && c.close >= (bbLower[i] as number);

    const volZ = volumeZScoreAt(volumes, 20, i);
    const capitulation = volZ != null && volZ >= PARAMS.volZMin;

    const prev = i > 0 ? candles[i - 1] : undefined;
    const pattern = detectCandle(c, prev);
    const reboundCandle = pattern.longLowerWick || pattern.bullishEngulfing;

    const gapPct = prev && prev.close > 0 ? ((c.open - prev.close) / prev.close) * 100 : 0;
    const gapOk = gapPct > -PARAMS.gapMaxDown;

    const buy = !!(dropOk && rsiOk && brokeLowerRecently && reenteredBand && capitulation && reboundCandle && gapOk);
    const exit = ma5[i] != null && c.close < (ma5[i] as number);

    return {
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      buy, exit,
      lines: { ma5: ma5[i], bbLower: bbLower[i] },
      m: {
        ret5, ret10, rsi: rsi[i], volZ, capitulation: capitulation ? 1 : 0, reboundCandle: reboundCandle ? 1 : 0,
        bbReentry: brokeLowerRecently && reenteredBand ? 1 : 0, ma5: ma5[i],
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
  return { entry_price: entry, shares, sl, note: `과매도 투매 반등 매수 · 손절가 ${Math.round(sl).toLocaleString('ko-KR')}` };
}

function stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null } {
  const events: ExitEvent[] = [];
  let { shares, tp1_hit } = pos;
  const entry = pos.entry_price;
  const ma5 = row.lines.ma5;

  if (row.close <= pos.sl) {
    events.push({ side: 'SELL_SL', price: row.close, shares, pnl: shares * (row.close - entry), note: '손절 청산', time: row.time });
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
  if (shares > 0 && ma5 != null && row.close < ma5) {
    events.push({ side: 'SELL_TP2', price: row.close, shares, pnl: shares * (row.close - entry), note: 'MA5 이탈 잔량 청산', time: row.time });
    return { events, updated: null };
  }
  const days = daysElapsed(row.time, pos.opened_at);
  if (shares > 0 && days >= PARAMS.maxDays) {
    events.push({ side: 'SELL_TP2', price: row.close, shares, pnl: shares * (row.close - entry), note: '2거래일 경과 무조건 전량 청산', time: row.time });
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
  const ret10 = last?.m.ret10 ?? null;
  const dropOk = (ret5 != null && ret5 <= -PARAMS.drop5) || (ret10 != null && ret10 <= -PARAMS.drop10);
  const rsi = last?.m.rsi ?? null;
  const rsiOk = rsi != null && rsi <= PARAMS.rsiMax;
  const volZ = last?.m.volZ ?? null;
  const capitulation = last?.m.capitulation === 1;
  const reboundCandle = last?.m.reboundCandle === 1;

  const conditions = [
    { label: `5일 -${PARAMS.drop5}%/10일 -${PARAMS.drop10}% 급락`, met: dropOk, pts: 25 },
    { label: `RSI(14) ≤ ${PARAMS.rsiMax} 과매도`, met: rsiOk, pts: 20 },
    { label: '볼린저 하단 이탈 후 재진입', met: last?.m.bbReentry === 1, pts: 15 },
    { label: `거래량 Z ≥ ${PARAMS.volZMin} (투매)`, met: capitulation, pts: 20 },
    { label: '반등 캔들 (긴 아래꼬리/장악형)', met: reboundCandle, pts: 20 },
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
      { value: volZ != null ? volZ.toFixed(1) + 'σ' : '-', tone: capitulation ? 'up' : 'muted' },
    ],
    conditions,
  };
}

export const rebound: StrategyModule = {
  code: 'rebound',
  name: '전략6 · (하락) 과매도 반등',
  short: '일봉 기준 5일 -8%/10일 -12% 급락 + RSI(14)≤25 + 볼린저 하단 이탈 후 재진입 + 거래량 Z≥2.5(투매) + 반등캔들 시 매수. 분할익절(+2.5%/+5%) 후 MA5 이탈 잔량 청산, 2거래일 무조건 전량 시간청산.',
  interval: '1d',
  range: '1y',
  positionPct: PARAMS.positionPct,
  params: PARAMS,
  regime: 'BEAR', risk: 4,
  lineStyles: [
    { key: 'ma5', color: '#f59e0b', width: 2, label: 'MA5' },
    { key: 'bbLower', color: '#22c55e', width: 1, label: '볼린저 하단' },
  ],
  colHeaders: ['5일등락', 'RSI', '거래량Z'],
  rules: [
    { tag: '①', color: 'text-accent', title: '진입', body: '5일 -8% 또는 10일 -12% 이상 급락 + RSI(14)≤25 + 볼린저 하단 이탈 후 밴드 안 재진입 + 거래량 Z-score 2.5 이상(투매 확인) + 반등 캔들(긴 아래꼬리/장악형) 시 가용 현금 10% 매수. 갭하락 -5% 초과 시 제외.' },
    { tag: '②', color: 'text-amber-400', title: '손절', body: 'max(반등봉 저가, 진입가 -2.5%) 중 타이트한 값.' },
    { tag: '③', color: 'text-profit', title: '분할 익절', body: '+2.5% 도달 시 40%, +5% 도달 시 추가 익절. 잔여는 MA5 종가 이탈 시 전량 청산.' },
    { tag: '④', color: 'text-slate-300', title: '시간 청산', body: '2거래일 경과 시 수익 여부와 무관하게 잔여 물량 무조건 전량 청산 (추세전환 기대 금지 원칙).' },
  ],
  compute, scan, planEntry, stepOpen,
};
