// ===== 시세 데이터 엔진 =====
// 1순위: Yahoo Finance (개발: Vite 프록시 / 배포: Netlify Function 프록시)
// 실패 시: 합성 데이터(데모 모드)로 폴백하여 시뮬레이션 지속 가능
import type { Candle, StockDef } from './types';

export const KOSPI_STOCKS: StockDef[] = [
  { symbol: '005930.KS', name: '삼성전자', market: 'KOSPI' },
  { symbol: '000660.KS', name: 'SK하이닉스', market: 'KOSPI' },
  { symbol: '373220.KS', name: 'LG에너지솔루션', market: 'KOSPI' },
  { symbol: '207940.KS', name: '삼성바이오로직스', market: 'KOSPI' },
  { symbol: '005380.KS', name: '현대차', market: 'KOSPI' },
  { symbol: '000270.KS', name: '기아', market: 'KOSPI' },
  { symbol: '035420.KS', name: 'NAVER', market: 'KOSPI' },
  { symbol: '035720.KS', name: '카카오', market: 'KOSPI' },
  { symbol: '005490.KS', name: 'POSCO홀딩스', market: 'KOSPI' },
  { symbol: '051910.KS', name: 'LG화학', market: 'KOSPI' },
  { symbol: '006400.KS', name: '삼성SDI', market: 'KOSPI' },
  { symbol: '105560.KS', name: 'KB금융', market: 'KOSPI' },
  { symbol: '055550.KS', name: '신한지주', market: 'KOSPI' },
  { symbol: '068270.KS', name: '셀트리온', market: 'KOSPI' },
  { symbol: '012330.KS', name: '현대모비스', market: 'KOSPI' },
];

export const KOSDAQ_STOCKS: StockDef[] = [
  { symbol: '247540.KQ', name: '에코프로비엠', market: 'KOSDAQ' },
  { symbol: '086520.KQ', name: '에코프로', market: 'KOSDAQ' },
  { symbol: '196170.KQ', name: '알테오젠', market: 'KOSDAQ' },
  { symbol: '028300.KQ', name: 'HLB', market: 'KOSDAQ' },
  { symbol: '263750.KQ', name: '펄어비스', market: 'KOSDAQ' },
  { symbol: '293490.KQ', name: '카카오게임즈', market: 'KOSDAQ' },
  { symbol: '035900.KQ', name: 'JYP Ent.', market: 'KOSDAQ' },
  { symbol: '041510.KQ', name: '에스엠', market: 'KOSDAQ' },
];

export const ALL_STOCKS = [...KOSPI_STOCKS, ...KOSDAQ_STOCKS];

export function stockName(symbol: string): string {
  return ALL_STOCKS.find((s) => s.symbol === symbol)?.name ?? symbol;
}

export type Interval = '15m' | '60m' | '1d';

// Yahoo interval 별 최대 조회 범위
export const RANGE_BY_INTERVAL: Record<Interval, string[]> = {
  '15m': ['5d', '1mo', '60d'],
  '60m': ['1mo', '3mo', '1y', '2y'],
  '1d': ['3mo', '6mo', '1y', '2y', '5y', 'max'],
};

const cache = new Map<string, { at: number; data: Candle[] }>();
const CACHE_TTL = 60_000;

export async function fetchCandles(
  symbol: string,
  interval: Interval = '15m',
  range = '60d',
): Promise<{ candles: Candle[]; demo: boolean }> {
  const key = `${symbol}|${interval}|${range}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { candles: hit.data, demo: false };

  try {
    const url = `/api/yahoo/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(json?.chart?.error?.description ?? 'no data');

    const ts: number[] = result.timestamp ?? [];
    const q = result.indicators?.quote?.[0] ?? {};
    const candles: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      candles.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
    }
    if (candles.length < 30) throw new Error('insufficient data');
    cache.set(key, { at: Date.now(), data: candles });
    return { candles, demo: false };
  } catch {
    // ── 데모 모드: 결정론적 합성 데이터 (심볼 기반 시드 → 항상 동일한 차트) ──
    const candles = generateSynthetic(symbol, interval, range);
    return { candles, demo: true };
  }
}

// 지수 조회 (KOSPI ^KS11, KOSDAQ ^KQ11)
export async function fetchIndexQuote(symbol: string): Promise<{ price: number; changePct: number; demo: boolean }> {
  const { candles, demo } = await fetchCandles(symbol, '1d', '3mo');
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  return {
    price: last?.close ?? 0,
    changePct: prev ? ((last.close - prev.close) / prev.close) * 100 : 0,
    demo,
  };
}

// ===== 합성 데이터 생성기 (수렴→이탈→회귀 패턴 포함, 시드 고정) =====
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSynthetic(symbol: string, interval: Interval, range: string): Candle[] {
  let seed = 0;
  for (const ch of symbol) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
  const rand = mulberry32(seed);

  const barSec = interval === '15m' ? 900 : interval === '60m' ? 3600 : 86400;
  const count =
    interval === '1d'
      ? range === 'max' || range === '5y' ? 1250 : range === '2y' ? 500 : range === '1y' ? 250 : 120
      : 500;

  let price = 10_000 + Math.floor(rand() * 90) * 1000;
  const candles: Candle[] = [];
  const now = Math.floor(Date.now() / 1000);
  let vol = 0.012; // 변동성 (수렴/발산 사이클)
  let volPhase = rand() * Math.PI * 2;

  for (let i = 0; i < count; i++) {
    // 변동성 사이클: 수렴 구간과 발산 구간이 주기적으로 반복
    volPhase += 0.06 + rand() * 0.04;
    vol = 0.004 + 0.014 * (0.5 + 0.5 * Math.sin(volPhase));

    const drift = (rand() - 0.495) * vol * price;
    // 하단 이탈 후 평균 회귀 성향 부여
    const meanRev = (rand() < 0.3 ? 0.3 : 0) * -drift;
    const open = price;
    const close = Math.max(100, price + drift + meanRev);
    const high = Math.max(open, close) * (1 + rand() * vol * 0.6);
    const low = Math.min(open, close) * (1 - rand() * vol * 0.6);
    const volume = Math.floor(50_000 + rand() * 500_000 * (1 + vol * 50));
    candles.push({ time: now - (count - i) * barSec, open, high, low, close, volume });
    price = close;
  }
  return candles;
}
