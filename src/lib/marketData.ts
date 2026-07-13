// ===== 시세 데이터 엔진 =====
// Yahoo Finance (개발: Vite 프록시 / 배포: Netlify Function 프록시)
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

// ── 시총 상위 확장 목록 (주요종목 외 대형주) ──
const KOSPI_EXTRA: StockDef[] = [
  { symbol: '028260.KS', name: '삼성물산', market: 'KOSPI' },
  { symbol: '066570.KS', name: 'LG전자', market: 'KOSPI' },
  { symbol: '003670.KS', name: '포스코퓨처엠', market: 'KOSPI' },
  { symbol: '096770.KS', name: 'SK이노베이션', market: 'KOSPI' },
  { symbol: '034730.KS', name: 'SK', market: 'KOSPI' },
  { symbol: '015760.KS', name: '한국전력', market: 'KOSPI' },
  { symbol: '032830.KS', name: '삼성생명', market: 'KOSPI' },
  { symbol: '003550.KS', name: 'LG', market: 'KOSPI' },
  { symbol: '017670.KS', name: 'SK텔레콤', market: 'KOSPI' },
  { symbol: '030200.KS', name: 'KT', market: 'KOSPI' },
  { symbol: '086790.KS', name: '하나금융지주', market: 'KOSPI' },
  { symbol: '316140.KS', name: '우리금융지주', market: 'KOSPI' },
  { symbol: '138040.KS', name: '메리츠금융지주', market: 'KOSPI' },
  { symbol: '010130.KS', name: '고려아연', market: 'KOSPI' },
  { symbol: '009150.KS', name: '삼성전기', market: 'KOSPI' },
  { symbol: '018260.KS', name: '삼성에스디에스', market: 'KOSPI' },
  { symbol: '259960.KS', name: '크래프톤', market: 'KOSPI' },
  { symbol: '010950.KS', name: 'S-Oil', market: 'KOSPI' },
  { symbol: '011170.KS', name: '롯데케미칼', market: 'KOSPI' },
  { symbol: '051900.KS', name: 'LG생활건강', market: 'KOSPI' },
  { symbol: '000810.KS', name: '삼성화재', market: 'KOSPI' },
  { symbol: '024110.KS', name: '기업은행', market: 'KOSPI' },
  { symbol: '323410.KS', name: '카카오뱅크', market: 'KOSPI' },
  { symbol: '047050.KS', name: '포스코인터내셔널', market: 'KOSPI' },
  { symbol: '042660.KS', name: '한화오션', market: 'KOSPI' },
  { symbol: '009540.KS', name: 'HD한국조선해양', market: 'KOSPI' },
  { symbol: '010140.KS', name: '삼성중공업', market: 'KOSPI' },
  { symbol: '000100.KS', name: '유한양행', market: 'KOSPI' },
  { symbol: '271560.KS', name: '오리온', market: 'KOSPI' },
  { symbol: '097950.KS', name: 'CJ제일제당', market: 'KOSPI' },
  { symbol: '021240.KS', name: '코웨이', market: 'KOSPI' },
  { symbol: '012450.KS', name: '한화에어로스페이스', market: 'KOSPI' },
  { symbol: '064350.KS', name: '현대로템', market: 'KOSPI' },
  { symbol: '011070.KS', name: 'LG이노텍', market: 'KOSPI' },
  { symbol: '006800.KS', name: '미래에셋증권', market: 'KOSPI' },
  { symbol: '078930.KS', name: 'GS', market: 'KOSPI' },
  { symbol: '004020.KS', name: '현대제철', market: 'KOSPI' },
  { symbol: '267250.KS', name: 'HD현대', market: 'KOSPI' },
  { symbol: '034020.KS', name: '두산에너빌리티', market: 'KOSPI' },
  { symbol: '042700.KS', name: '한미반도체', market: 'KOSPI' },
];

const KOSDAQ_EXTRA: StockDef[] = [
  { symbol: '068760.KQ', name: '셀트리온제약', market: 'KOSDAQ' },
  { symbol: '066970.KQ', name: '엘앤에프', market: 'KOSDAQ' },
  { symbol: '058470.KQ', name: '리노공업', market: 'KOSDAQ' },
  { symbol: '240810.KQ', name: '원익IPS', market: 'KOSDAQ' },
  { symbol: '357780.KQ', name: '솔브레인', market: 'KOSDAQ' },
  { symbol: '277810.KQ', name: '레인보우로보틱스', market: 'KOSDAQ' },
  { symbol: '112040.KQ', name: '위메이드', market: 'KOSDAQ' },
  { symbol: '145020.KQ', name: '휴젤', market: 'KOSDAQ' },
  { symbol: '214150.KQ', name: '클래시스', market: 'KOSDAQ' },
  { symbol: '328130.KQ', name: '루닛', market: 'KOSDAQ' },
  { symbol: '141080.KQ', name: '리가켐바이오', market: 'KOSDAQ' },
  { symbol: '022100.KQ', name: '포스코DX', market: 'KOSDAQ' },
  { symbol: '039030.KQ', name: '이오테크닉스', market: 'KOSDAQ' },
  { symbol: '036930.KQ', name: '주성엔지니어링', market: 'KOSDAQ' },
  { symbol: '253450.KQ', name: '스튜디오드래곤', market: 'KOSDAQ' },
  { symbol: '348370.KQ', name: '엔켐', market: 'KOSDAQ' },
  { symbol: '403870.KQ', name: 'HPSP', market: 'KOSDAQ' },
  { symbol: '195940.KQ', name: 'HK이노엔', market: 'KOSDAQ' },
  { symbol: '000250.KQ', name: '삼천당제약', market: 'KOSDAQ' },
  { symbol: '214450.KQ', name: '파마리서치', market: 'KOSDAQ' },
  { symbol: '078600.KQ', name: '대주전자재료', market: 'KOSDAQ' },
];

/** 코스피 시총 상위 (주요 + 대형주 확장) */
export const KOSPI_TOP: StockDef[] = [...KOSPI_STOCKS, ...KOSPI_EXTRA];
/** 코스닥 시총 상위 (주요 + 대형주 확장) */
export const KOSDAQ_TOP: StockDef[] = [...KOSDAQ_STOCKS, ...KOSDAQ_EXTRA];

export const ALL_STOCKS = [...KOSPI_TOP, ...KOSDAQ_TOP];

export function stockName(symbol: string): string {
  return ALL_STOCKS.find((s) => s.symbol === symbol)?.name ?? symbol;
}

// ── 스캔 대상 유니버스 ──
export interface UniverseOption { key: string; label: string }
export const UNIVERSE_OPTIONS: UniverseOption[] = [
  { key: 'KOSPI', label: `코스피 주요종목 (${KOSPI_STOCKS.length})` },
  { key: 'KOSDAQ', label: `코스닥 주요종목 (${KOSDAQ_STOCKS.length})` },
  { key: 'KOSPI_ALL', label: `코스피 시총 상위 (${KOSPI_TOP.length})` },
  { key: 'KOSDAQ_ALL', label: `코스닥 시총 상위 (${KOSDAQ_TOP.length})` },
  { key: 'ALL', label: `전체 (코스피+코스닥 ${ALL_STOCKS.length})` },
  { key: 'WATCH', label: '관심종목' },
];

/** 유니버스 키 → 종목 목록 (WATCH 는 호출자가 관심종목으로 대체) */
export function universeStocks(key: string): StockDef[] {
  switch (key) {
    case 'KOSPI': return KOSPI_STOCKS;
    case 'KOSDAQ': return KOSDAQ_STOCKS;
    case 'KOSPI_ALL': return KOSPI_TOP;
    case 'KOSDAQ_ALL': return KOSDAQ_TOP;
    case 'ALL': return ALL_STOCKS;
    default: return [];
  }
}
export function universeLabel(key: string): string {
  return UNIVERSE_OPTIONS.find((u) => u.key === key)?.label ?? key;
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

/** UTC 타임스탐프 → KST 타임스탐프 (초 단위) */
function toKST(utcSeconds: number): number {
  return utcSeconds + 32400; // 9시간 = 32400초
}

export async function fetchCandles(
  symbol: string,
  interval: Interval = '15m',
  range = '60d',
): Promise<{ candles: Candle[]; demo: boolean }> {
  const key = `${symbol}|${interval}|${range}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL && hit.data.length >= 10) return { candles: hit.data, demo: false };

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
      candles.push({ time: toKST(ts[i]), open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
    }
    if (candles.length < 2) throw new Error('insufficient data');
    cache.set(key, { at: Date.now(), data: candles });
    return { candles, demo: false };
  } catch (e) {
    // ── 데모 모드: 결정론적 합성 데이터 (심볼 기반 시드 → 항상 동일한 차트) ──
    // 실패 사유를 콘솔에 남겨 실시세 조회 실패 원인(네트워크 차단/레이트리밋 등)을 진단할 수 있게 함.
    console.warn(`[marketData] ${symbol} 실시세 조회 실패 → 데모 데이터로 대체:`, e instanceof Error ? e.message : e);
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

// ===== 종목 시세 요약 (전체 종목 리스트용) =====
export interface Quote {
  symbol: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  changePct: number;
  tradeValue: number; // 대금 ≈ 종가 × 거래량
  demo: boolean;
}

export async function fetchQuote(symbol: string): Promise<Quote> {
  const { candles, demo } = await fetchCandles(symbol, '1d', '5d');
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const price = last?.close ?? 0;
  const prevClose = prev?.close ?? price;
  const volume = last?.volume ?? 0;
  return {
    symbol, price, prevClose,
    open: last?.open ?? 0, high: last?.high ?? 0, low: last?.low ?? 0, volume,
    changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
    tradeValue: price * volume,
    demo,
  };
}

export interface Fundamentals { per?: number; pbr?: number; eps?: number; marketCap?: number }
const fundCache = new Map<string, Fundamentals>();
// quoteSummary 는 Yahoo crumb 정책상 차단(401)되는 경우가 많다.
// 연속 실패 시 이후 요청을 생략해 불필요한 네트워크 호출을 막는다.
let fundFailStreak = 0;
let fundDisabled = false;

/** PER/PBR/EPS/시총 (Yahoo quoteSummary) — 실패 시 빈 객체로 폴백 */
export async function fetchFundamentals(symbol: string): Promise<Fundamentals> {
  const hit = fundCache.get(symbol);
  if (hit) return hit;
  if (fundDisabled) return {};
  try {
    const res = await fetch(`/api/yahoo/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=summaryDetail,defaultKeyStatistics,price`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const r = j?.quoteSummary?.result?.[0] ?? {};
    const sd = r.summaryDetail ?? {};
    const ks = r.defaultKeyStatistics ?? {};
    const pr = r.price ?? {};
    const f: Fundamentals = {
      per: sd.trailingPE?.raw,
      pbr: sd.priceToBook?.raw ?? ks.priceToBook?.raw,
      eps: ks.trailingEps?.raw,
      marketCap: sd.marketCap?.raw ?? pr.marketCap?.raw,
    };
    fundFailStreak = 0;
    fundCache.set(symbol, f);
    return f;
  } catch {
    if (++fundFailStreak >= 5) fundDisabled = true; // 연속 5회 실패 시 이후 생략
    return {};
  }
}

/** 큰 원화 금액 → 조/억 단위 문자열 */
export function fmtKRWLarge(n: number | undefined | null): string {
  if (n == null || !isFinite(n) || n === 0) return '-';
  const jo = Math.floor(n / 1_0000_0000_0000);
  const eok = Math.floor((n % 1_0000_0000_0000) / 1_0000_0000);
  if (jo > 0) return `${jo}조 ${eok > 0 ? eok.toLocaleString('ko-KR') + '억' : ''}`.trim();
  if (eok > 0) return `${eok.toLocaleString('ko-KR')}억`;
  return `${Math.round(n).toLocaleString('ko-KR')}`;
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
