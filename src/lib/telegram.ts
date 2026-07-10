// ===== 텔레그램 알림 (사용자별 개인 봇) =====
// 봇 토큰/chat_id 는 사용자별로 프로필에 저장한다.
// 실제 발송은 서버(Netlify 함수/예약함수)에서 수행하며, 이 파일은
// 프론트엔드 테스트 발송 + 메시지 포맷 유틸을 제공한다 (서버도 포맷 유틸을 재사용).

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
  notifyBuy: boolean;
  notifyWatch: boolean;
  notifySell: boolean;
  intervalMin: number;
  sellIntervalMin: number;
  universe: string;
  strategy: string;
}

export const DEFAULT_TELEGRAM: TelegramConfig = {
  botToken: '',
  chatId: '',
  enabled: false,
  notifyBuy: true,
  notifyWatch: true,
  notifySell: true,
  intervalMin: 10,
  sellIntervalMin: 10,
  universe: 'KOSPI',
  strategy: 'bnf1',
};

/** 프론트엔드 테스트 발송 — Netlify 함수(/api/telegram) 프록시 경유 (CORS 회피) */
export async function sendTelegramTest(
  botToken: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken, chatId, text }),
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok && j.ok !== false, error: j.error ?? (res.ok ? undefined : `HTTP ${res.status}`) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

const nowStr = () =>
  new Date().toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface BuyItem { name: string; price: number; score: number; stars: number }

/** 매수 시그널 다이제스트 메시지 (HTML) */
export function fmtBuyMessage(stratName: string, universeLabel: string, buys: BuyItem[]): string {
  const head = `📈 <b>[BNF Trading Studio] 매수 시그널</b>\n전략: ${esc(stratName)}\n대상: ${esc(universeLabel)}\n시각: ${nowStr()}\n`;
  if (buys.length === 0) return head + '\n현재 조건을 만족하는 매수 가능 종목이 없습니다.';
  const body = buys
    .map((b) => `✅ <b>${esc(b.name)}</b>  ${Math.round(b.price).toLocaleString('ko-KR')}원  (${b.score}점 ${'★'.repeat(b.stars)}${'☆'.repeat(5 - b.stars)})`)
    .join('\n');
  return `${head}\n${body}`;
}

export interface WatchItem { name: string; kind: '매수' | '매도'; price: number }

/** 관심종목 매수/매도 시그널 메시지 (HTML) */
export function fmtWatchMessage(stratName: string, items: WatchItem[]): string {
  const head = `⭐ <b>[BNF Trading Studio] 관심종목 시그널</b>\n전략: ${esc(stratName)}\n시각: ${nowStr()}\n`;
  const body = items
    .map((w) => `${w.kind === '매수' ? '🟢' : '🔴'} <b>${esc(w.name)}</b>  ${w.kind} 신호  ${Math.round(w.price).toLocaleString('ko-KR')}원`)
    .join('\n');
  return `${head}\n${body}`;
}

export interface PositionAlertItem { name: string; stratName: string; entryPrice: number; shares: number; price: number }

/** 등록 포지션 매도 시그널 메시지 (HTML) */
export function fmtPositionMessage(items: PositionAlertItem[]): string {
  const head = `💼 <b>[BNF Trading Studio] 보유 포지션 매도 시그널</b>\n시각: ${nowStr()}\n\n등록하신 포지션에서 매도 신호가 발생했습니다:\n`;
  const body = items.map((p) => {
    const pnl = (p.price - p.entryPrice) * p.shares;
    const pct = p.entryPrice > 0 ? ((p.price - p.entryPrice) / p.entryPrice) * 100 : 0;
    return `🔻 <b>${esc(p.name)}</b> (${esc(p.stratName)})\n   매수가 ${Math.round(p.entryPrice).toLocaleString('ko-KR')}원 → 현재 ${Math.round(p.price).toLocaleString('ko-KR')}원 · 평가손익 ${Math.round(pnl).toLocaleString('ko-KR')}원 (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
  }).join('\n');
  return `${head}\n${body}\n\n※ 포지션을 청산 처리하기 전까지 설정한 주기마다 반복 발송됩니다.`;
}

export interface SellItem { name: string; note: string; price: number }

/** 모의투자 매도 시그널 메시지 (HTML) */
export function fmtSellMessage(stratName: string, items: SellItem[]): string {
  const head = `🔔 <b>[BNF Trading Studio] 모의투자 매도 시그널</b>\n전략: ${esc(stratName)}\n시각: ${nowStr()}\n\n아래 보유 종목에서 청산 신호가 발생했습니다:\n`;
  const body = items
    .map((s) => `🔻 <b>${esc(s.name)}</b>  ${esc(s.note)}  ${Math.round(s.price).toLocaleString('ko-KR')}원`)
    .join('\n');
  return `${head}\n${body}\n\n※ 모의투자에서 직접 매도하기 전까지 지정한 주기마다 계속 알림이 발송됩니다.`;
}
