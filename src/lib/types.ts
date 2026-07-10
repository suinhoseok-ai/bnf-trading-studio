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

export interface TelegramSettings {
  botToken?: string;
  chatId?: string;
  enabled?: boolean; // 알림 전체 on/off
  notifyBuy?: boolean; // 매수 시그널 알림 (유니버스 스캔)
  notifyWatch?: boolean; // 관심종목 매수/매도 시그널 알림
  notifySell?: boolean; // 모의투자 매도 시그널 알림
  intervalMin?: number; // 매수/관심종목 알림 주기(분)
  sellIntervalMin?: number; // 모의투자 매도 알림 주기(분)
  universe?: string; // 매수 스캔 대상 유니버스 키
  strategy?: string; // 매수 스캔 전략 코드
  lastNotifiedAt?: string; // 매수/관심 마지막 발송 시각 (ISO)
  lastSellAt?: string; // 모의투자 매도 마지막 발송 시각 (ISO)
}

/** 관리자 전역 설정 (일일 이메일 스캔 리포트 등) */
export interface AdminConfig {
  reportEnabled?: boolean;
  reportDays?: number[]; // 1=월 ~ 5=금 (0=일,6=토)
  reportHour?: number; // 발송 시각 (KST 0~23)
  reportStrategy?: string; // 스캔 전략 코드
  reportMarket?: 'KOSPI' | 'KOSDAQ' | 'ALL'; // 대상 시장
  reportMaxStocks?: number; // 스캔 최대 종목 수
  reportSortBy?: 'score' | 'changePct'; // 정렬 기준
  reportTopN?: number; // 상위 N개 발송
  reportRecipient?: string; // 수신 이메일
  reportLastSentDate?: string; // 마지막 발송일 (KST YYYY-MM-DD)
  // ── 전체 리포트 (전 전략 × 주요 종목) 메일 ──
  fullReportEnabled?: boolean;
  fullReportDays?: number[]; // 1=월 ~ 5=금
  fullReportHour?: number; // KST 0~23
  fullReportRecipient?: string;
  fullReportLastSentDate?: string;
}

/** 수동 등록 포지션 (실보유 알림용) */
export interface UserPosition {
  id: number;
  symbol: string;
  name: string;
  strategy_code: string;
  entry_price: number;
  shares: number;
  alert_enabled: boolean;
  status: 'OPEN' | 'CLOSED';
  opened_at: string;
  closed_at?: string | null;
}

export interface Profile {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  approved: boolean;
  settings: { ollamaUrl?: string; ollamaModel?: string; telegram?: TelegramSettings };
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
