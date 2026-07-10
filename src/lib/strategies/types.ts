// ===== 다중 매매전략 공통 인터페이스 =====
// 모든 전략(BNF1, 추세돌파, 눌림목, 정배열, 박스권)은 이 인터페이스를 구현한다.
// 프론트엔드(스캐너/백테스트/모의투자/차트)와 서버(텔레그램 알림 함수)가 동일 로직을 공유한다.
import type { Candle, BacktestResult } from '../types';
import type { Interval } from '../marketData';

/** 지표가 계산된 봉 1개 (전략 공통) */
export interface StratRow extends Candle {
  buy: boolean; // 이 봉에서 신규 매수 신호 발생
  exit: boolean; // 이 봉에서 (보유 중이라면) 추세 이탈/청산 신호 발생 — 화면 표시용
  lines: Record<string, number | null>; // 차트 오버레이 라인 (가격 레벨)
  m: Record<string, number | null>; // 스칼라 지표값 (스캐너 점수/표시용)
}

export type Tone = 'up' | 'down' | 'accent' | 'muted' | 'default';
export interface ScanCol {
  value: string;
  tone?: Tone;
}

/** 스캐너 1종목 결과 (전략 공통) */
export interface StratScan {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  buy: boolean; // 현재 매수 신호
  exit: boolean; // 현재 매도(청산) 신호
  score: number; // 0~100
  stars: number; // 1~5
  cols: ScanCol[]; // 전략별 지표 컬럼 값 (colHeaders와 1:1)
  conditions: { label: string; met: boolean; pts: number }[];
  error?: string;
}

/** 보유 포지션 (모의투자/백테스트 공통) */
export interface OpenPos {
  symbol: string;
  name: string;
  entry_price: number;
  shares: number;
  sl: number;
  tp1_hit: boolean;
  opened_at: string; // ISO
}

export interface ExitEvent {
  side: 'SELL_TP1' | 'SELL_TP2' | 'SELL_SL';
  price: number;
  shares: number;
  pnl: number;
  note: string;
  time: number;
}

export interface EntryPlan {
  entry_price: number;
  shares: number;
  sl: number;
  note: string;
}

export interface LineStyle {
  key: string; // StratRow.lines 의 키
  color: string;
  width?: number;
  label: string; // 범례 표시
}

/** 캔들 조회 함수 (클라이언트/서버가 각자 구현을 주입) */
export type CandleFetcher = (symbol: string, interval: Interval, range: string) => Promise<Candle[]>;

/** 전략 모듈 — 각 전략이 구현 */
export interface StrategyModule {
  code: string;
  name: string;
  short: string; // 한 줄 설명
  interval: Interval; // 기본 봉 주기
  range: string; // 기본 조회 기간
  positionPct: number; // 진입 비중 (% of cash)
  params: Record<string, number>;
  lineStyles: LineStyle[]; // 차트에 그릴 라인
  colHeaders: string[]; // 스캐너 지표 컬럼 헤더
  rules: { tag: string; color: string; title: string; body: string }[]; // 대시보드 요약 카드
  /** 선택: 전략이 필요로 하는 외부 데이터(예: 시장 지수) 준비 — compute 호출 전에 실행 */
  init?(fetch: CandleFetcher): Promise<void>;
  compute(candles: Candle[]): StratRow[];
  scan(symbol: string, name: string, rows: StratRow[]): StratScan;
  /** i번째 봉의 매수 신호에 대한 진입 계획 (진입가/수량/손절가). null이면 진입 안함 */
  planEntry(rows: StratRow[], i: number, cash: number): EntryPlan | null;
  /** 보유 포지션에 봉 1개를 적용해 청산 이벤트 산출 (updated=null이면 전량 청산) */
  stepOpen(pos: OpenPos, row: StratRow): { events: ExitEvent[]; updated: OpenPos | null };
}

export type { BacktestResult };
