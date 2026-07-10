// ===== 모의투자 엔진 =====
// 보유 포지션에 대해 신규 봉 데이터를 순차 적용하여
// 손절 / 1차 익절(본절 이동) / 2차 익절 이벤트를 산출한다.
import type { IndicatorRow } from './types';

export interface PaperPosition {
  id?: number;
  symbol: string;
  name: string;
  entry_price: number;
  shares: number;
  sl: number;
  tp1_hit: boolean;
  opened_at: string; // ISO
}

export interface PaperEvent {
  side: 'SELL_TP1' | 'SELL_TP2' | 'SELL_SL';
  price: number;
  shares: number;
  pnl: number;
  note: string;
  time: number;
}

/** opened_at 이후의 봉들을 순차 적용. 반환: 발생 이벤트 + 갱신된 포지션(null이면 전량 청산) */
export function processPosition(
  pos: PaperPosition,
  rows: IndicatorRow[],
): { events: PaperEvent[]; updated: PaperPosition | null } {
  const openedSec = Math.floor(new Date(pos.opened_at).getTime() / 1000);
  const events: PaperEvent[] = [];
  let { shares, sl, tp1_hit } = pos;
  const entry = pos.entry_price;
  // 잔여 취득원가: TP1 이전엔 entry*shares, 이후 잔량도 entry 기준
  for (const row of rows) {
    if (row.time <= openedSec) continue;

    // 1. 손절/본절
    if (row.low <= sl) {
      const pnl = shares * (sl - entry);
      events.push({ side: 'SELL_SL', price: sl, shares, pnl, note: tp1_hit ? '본절 청산' : '손절 청산', time: row.time });
      return { events, updated: null };
    }
    // 2. 1차 익절 (중심선)
    if (!tp1_hit && row.ma20 != null && row.high >= row.ma20) {
      const half = shares * 0.5;
      const pnl = half * (row.ma20 - entry);
      events.push({ side: 'SELL_TP1', price: row.ma20, shares: half, pnl, note: '중심선 50% 익절 · 손절가 본절 이동', time: row.time });
      shares -= half;
      tp1_hit = true;
      sl = entry;
    }
    // 3. 2차 익절 (상단밴드)
    if (tp1_hit && row.upperBand != null && row.high >= row.upperBand) {
      const pnl = shares * (row.upperBand - entry);
      events.push({ side: 'SELL_TP2', price: row.upperBand, shares, pnl, note: '상단밴드 전량 익절', time: row.time });
      return { events, updated: null };
    }
  }
  return { events, updated: { ...pos, shares, sl, tp1_hit } };
}
