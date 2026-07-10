// ===== 24시간 서버 알림 (Netlify 예약 함수) =====
// 지정 주기마다 실행되어, 텔레그램 알림을 켠 모든 사용자에 대해
//   1) 선택한 전략/유니버스로 매수 시그널 스캔 → 매수 가능 종목 발송
//   2) 보유 모의투자 포지션의 매도(청산) 시그널 감지 → 발송 (매도 전까지 반복)
// 계산은 시스템(전략 엔진)이 수행하며 AI는 사용하지 않는다.
//
// 필요한 Netlify 환경변수:
//   SUPABASE_URL (또는 VITE_SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY   ← 전체 사용자 데이터 조회용 (RLS 우회)
import { createClient } from '@supabase/supabase-js';
import type { Candle } from '../../src/lib/types';
import { getStrategy, manageOpen } from '../../src/lib/strategies';
import { universeStocks, universeLabel } from '../../src/lib/marketData';
import { isKoreanMarketOpen } from '../../src/lib/market-hours';
import { fmtBuyMessage, fmtSellMessage, fmtWatchMessage, fmtPositionMessage } from '../../src/lib/telegram';
import type { BuyItem, SellItem, WatchItem, PositionAlertItem } from '../../src/lib/telegram';

export const config = { schedule: '*/10 * * * *' };

const BUY_SCAN_CAP = 40; // 예약함수 시간 제한 고려, 유니버스 상한
const BATCH = 6;

async function fetchCandlesServer(symbol: string, interval: string, range: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BNFStudio/1.0)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('no data');
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    candles.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  return candles;
}

async function inBatches<T>(arr: T[], size: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < arr.length; i += size) {
    await Promise.all(arr.slice(i, i + size).map(fn));
  }
}

async function tgSend(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return (await r.json())?.ok === true;
  } catch {
    return false;
  }
}

export default async () => {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log('[notify] Supabase 환경변수(SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) 미설정 — 건너뜀');
    return new Response('skip: env missing');
  }
  // ── 한국 정규장(평일 09:00~15:30)에만 발송 ──
  if (!isKoreanMarketOpen()) {
    console.log('[notify] 장 시간이 아니므로 건너뜀');
    return new Response('skip: market closed');
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { data: profiles, error } = await sb.from('bnf_profiles').select('id, email, settings');
  if (error) {
    console.log('[notify] profiles 조회 실패:', error.message);
    return new Response('error: profiles');
  }

  const now = Date.now();
  const ms = (t?: string) => (t ? new Date(t).getTime() : 0);
  let sentCount = 0;

  for (const p of profiles ?? []) {
    const uid = (p as { id: string }).id;
    const settings = (p as { settings?: Record<string, unknown> }).settings ?? {};
    const tg = (settings.telegram ?? {}) as {
      botToken?: string; chatId?: string; enabled?: boolean;
      notifyBuy?: boolean; notifyWatch?: boolean; notifySell?: boolean;
      intervalMin?: number; sellIntervalMin?: number;
      universe?: string; strategy?: string; lastNotifiedAt?: string; lastSellAt?: string;
    };
    if (!tg.enabled || !tg.botToken || !tg.chatId) continue;

    const buyDue = now - ms(tg.lastNotifiedAt) >= Math.max(5, tg.intervalMin ?? 10) * 60_000;
    const sellDue = now - ms(tg.lastSellAt) >= Math.max(5, tg.sellIntervalMin ?? tg.intervalMin ?? 10) * 60_000;
    if (!buyDue && !sellDue) continue;

    const mod = getStrategy(tg.strategy || 'bnf1');
    await mod.init?.(fetchCandlesServer); // 시장 지수 등 준비 (전략6)
    const messages: string[] = [];

    // ── 1. 매수 시그널 스캔 (유니버스) ──
    if (buyDue && tg.notifyBuy !== false) {
      const uniKey = tg.universe || 'KOSPI';
      const stocks = universeStocks(uniKey).slice(0, BUY_SCAN_CAP);
      const buys: BuyItem[] = [];
      await inBatches(stocks, BATCH, async (s) => {
        try {
          const candles = await fetchCandlesServer(s.symbol, mod.interval, mod.range);
          if (candles.length < 30) return;
          const scan = mod.scan(s.symbol, s.name, mod.compute(candles));
          if (scan.buy) buys.push({ name: s.name, price: scan.price, score: scan.score, stars: scan.stars });
        } catch { /* skip symbol */ }
      });
      if (buys.length > 0) messages.push(fmtBuyMessage(mod.name, universeLabel(uniKey), buys));
    }

    // ── 2. 관심종목 매수/매도 시그널 ──
    if (buyDue && tg.notifyWatch !== false) {
      const { data: wl } = await sb.from('bnf_watchlist').select('symbol, name').eq('user_id', uid).limit(30);
      const items: WatchItem[] = [];
      await inBatches((wl ?? []) as { symbol: string; name: string }[], BATCH, async (w) => {
        try {
          const scan = mod.scan(w.symbol, w.name || w.symbol, mod.compute(await fetchCandlesServer(w.symbol, mod.interval, mod.range)));
          if (scan.buy) items.push({ name: w.name || w.symbol, kind: '매수', price: scan.price });
          else if (scan.exit) items.push({ name: w.name || w.symbol, kind: '매도', price: scan.price });
        } catch { /* skip */ }
      });
      if (items.length > 0) messages.push(fmtWatchMessage(mod.name, items));
    }

    // ── 3. 모의투자 매도 시그널 감지 ──
    if (sellDue && tg.notifySell !== false) {
      const { data: positions } = await sb
        .from('bnf_paper_positions')
        .select('symbol, name, strategy_code, entry_price, shares, sl, tp1_hit, opened_at')
        .eq('user_id', uid)
        .eq('status', 'OPEN');
      const sells: SellItem[] = [];
      for (const pos of positions ?? []) {
        const po = pos as {
          symbol: string; name: string; strategy_code?: string;
          entry_price: number; shares: number; sl: number; tp1_hit: boolean; opened_at: string;
        };
        try {
          const pmod = getStrategy(po.strategy_code || 'bnf1');
          const rows = pmod.compute(await fetchCandlesServer(po.symbol, pmod.interval, pmod.range));
          const { events } = manageOpen(pmod, {
            symbol: po.symbol, name: po.name, entry_price: Number(po.entry_price), shares: Number(po.shares),
            sl: Number(po.sl), tp1_hit: po.tp1_hit, opened_at: po.opened_at,
          }, rows);
          if (events.length > 0) {
            const ev = events[events.length - 1];
            sells.push({ name: po.name || po.symbol, note: ev.note, price: ev.price });
          }
        } catch { /* skip position */ }
      }
      if (sells.length > 0) messages.push(fmtSellMessage('모의투자 보유 포지션', sells));
    }

    // ── 3.5 수동 등록 포지션(실보유) 매도 시그널 — 전략의 청산 신호(exit) 기준, 청산 처리 전까지 반복 ──
    if (sellDue) {
      const { data: upos } = await sb
        .from('bnf_user_positions')
        .select('id, symbol, name, strategy_code, entry_price, shares')
        .eq('user_id', uid)
        .eq('status', 'OPEN')
        .eq('alert_enabled', true);
      const alerts: PositionAlertItem[] = [];
      for (const pos of upos ?? []) {
        const po = pos as { symbol: string; name: string; strategy_code?: string; entry_price: number; shares: number };
        try {
          const pmod = getStrategy(po.strategy_code || 'bnf1');
          await pmod.init?.(fetchCandlesServer);
          const rows = pmod.compute(await fetchCandlesServer(po.symbol, pmod.interval, pmod.range));
          const last = rows[rows.length - 1];
          if (last?.exit) {
            alerts.push({
              name: po.name || po.symbol,
              stratName: pmod.name.split('·')[0].trim(),
              entryPrice: Number(po.entry_price),
              shares: Number(po.shares),
              price: last.close,
            });
          }
        } catch { /* skip position */ }
      }
      if (alerts.length > 0) messages.push(fmtPositionMessage(alerts));
    }

    // ── 4. 발송 + 마지막 발송시각 갱신 ──
    for (const msg of messages) {
      if (await tgSend(tg.botToken, tg.chatId, msg)) sentCount++;
    }
    const nextTg = { ...tg };
    if (buyDue) nextTg.lastNotifiedAt = new Date().toISOString();
    if (sellDue) nextTg.lastSellAt = new Date().toISOString();
    await sb.from('bnf_profiles').update({ settings: { ...settings, telegram: nextTg } }).eq('id', uid);
  }

  console.log(`[notify] 완료 · 메시지 ${sentCount}건 발송`);
  return new Response(`ok: ${sentCount} messages`);
};
