// ===== Broker Adapter 공통 인터페이스 (서버 전용) =====
// 전략 엔진이 증권사 API를 직접 호출하지 않도록 추상화한다.
// 브로커 교체 시 어댑터만 바꾸면 되고, 자동매매 엔진(trader.mts)은 수정하지 않는다.

export interface AccountSummary {
  totalAsset: number;    // 총평가자산
  cash: number;          // 예수금
  evalAmount: number;    // 보유주식 평가금액
  pnl: number;           // 평가손익 합계
  pnlPct: number;        // 수익률(%)
  positionCount: number; // 보유종목수
}

export interface BrokerPosition {
  symbol: string;      // 6자리 코드 (예: 005930)
  name: string;
  qty: number;
  sellableQty: number; // 주문가능수량
  avgPrice: number;    // 평균단가
  curPrice: number;    // 현재가
  evalAmount: number;
  pnl: number;
  pnlPct: number;
}

export interface OrderRecord {
  orderNo: string;
  date: string;        // YYYYMMDD
  time: string;        // HHMMSS
  symbol: string;
  name: string;
  side: string;        // 매수/매도
  qty: number;
  filledQty: number;
  orderPrice: number;
  avgFillPrice: number;
  status: string;      // 체결/미체결 등
}

export interface PlaceOrderResult {
  ok: boolean;
  orderNo?: string;
  message?: string;
}

/** 실시간 시세 스냅샷 (거래소 직접 조회 — 지연 없음) */
export interface BrokerQuote {
  symbol: string;
  price: number;      // 현재가
  changePct: number;  // 전일 대비 등락률(%)
  open: number;
  high: number;
  low: number;
  volume: number;     // 누적 거래량
}

export interface BrokerCredentials {
  appKey: string;
  appSecret: string;
  accountNo: string;         // 계좌번호 앞 8자리
  accountProductCd: string;  // 뒤 2자리 (보통 01)
  mode: 'paper' | 'real';    // paper=모의투자, real=실전
}

export interface TokenCache {
  access_token?: string;
  expires_at?: number; // epoch ms
}

/** 어댑터가 새 토큰을 발급받았을 때 호출 — 호출자가 DB에 캐시 저장 */
export type TokenPersist = (token: TokenCache) => Promise<void>;

export interface BrokerAdapter {
  readonly broker: 'kis' | 'toss';
  /** 토큰 확보 (캐시 유효 시 재사용, 만료 시 재발급 후 persist 콜백) */
  connect(): Promise<void>;
  getAccount(): Promise<AccountSummary>;
  getPositions(): Promise<BrokerPosition[]>;
  /** 계좌 요약 + 보유 포지션을 단일 API 호출로 함께 조회 (KIS는 동일 엔드포인트라 요청수 절감 목적) */
  getBalance(): Promise<{ account: AccountSummary; positions: BrokerPosition[] }>;
  getOrders(days?: number): Promise<OrderRecord[]>;
  getMarketPrice(symbol: string): Promise<number>;
  /** 실시간 현재가·등락률 등 시세 스냅샷 (지수는 ^KS11=KOSPI, ^KQ11=KOSDAQ) */
  getQuote(symbol: string): Promise<BrokerQuote>;
  /** price 미지정(0) 시 시장가 */
  placeBuyOrder(symbol: string, qty: number, price?: number): Promise<PlaceOrderResult>;
  placeSellOrder(symbol: string, qty: number, price?: number): Promise<PlaceOrderResult>;
  cancelOrder(orderNo: string, symbol: string, qty: number): Promise<PlaceOrderResult>;
}

export class BrokerError extends Error {
  constructor(message: string) { super(message); this.name = 'BrokerError'; }
}

/** '005930.KS' → '005930' (야후 심볼 → 국내 종목코드) */
export const toKrCode = (symbol: string) => symbol.replace(/\.(KS|KQ)$/i, '');
