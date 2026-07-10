// ===== 공통 타입 정의 =====

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// 지표가 계산된 캔들
export interface IndicatorRow extends Candle {
  ma20: number | null;
  std: number | null;
  upperBand: number | null;
  lowerBand: number | null;
  bandwidth: number | null;
  bwMa20: number | null;
  bwPct25: number | null; // 최근 100봉 밴드폭의 25 퍼센타일
  isSqueezed: boolean;
  buySignal: boolean; // BNF1 매수 신호
  rsi14: number | null;
  volMa20: number | null;
}

export interface TradeEvent {
  time: number;
  type: 'BUY' | 'TP1' | 'TP2' | 'SL' | 'EOD';
  price: number;
  shares: number;
  pnl: number;
  note: string;
}

export interface BacktestMetrics {
  totalReturn: number; // %
  winRate: number; // %
  mdd: number; // %
  profitFactor: number;
  sharpe: number;
  cagr: number; // %
  tradeCount: number;
  avgHoldBars: number;
  finalBalance: number;
  initialBalance: number;
}

export interface BacktestResult {
  metrics: BacktestMetrics;
  trades: TradeEvent[];
  equityCurve: { time: number; value: number }[];
  logs: string[];
}

// 스캐너 점수 결과
export interface ScanResult {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  bandwidth: number | null;
  bwPctRank: number | null; // 최근 100봉 중 현재 BW 백분위 (낮을수록 수렴)
  isSqueezed: boolean;
  belowLower: boolean;
  score: number; // 0~100
  stars: number; // 1~5
  conditions: { label: string; met: boolean; pts: number }[];
  error?: string;
}

export interface Profile {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  approved: boolean;
  settings: { ollamaUrl?: string; ollamaModel?: string };
  created_at: string;
}

export interface Strategy {
  id: number;
  code: string;
  name: string;
  description: string;
  enabled: boolean;
  params: Record<string, number>;
}

export interface StockDef {
  symbol: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
}
