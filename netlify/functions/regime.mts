// ===== 시장국면 판정 스케줄 함수 =====
// 10분마다 실행되지만 실제 판정은 KST 08:30(preopen)/11:00(midday)/15:30(close) ±5분 창에서만,
// 세션당 1회만 수행한다(unique(trade_date,session) + 사전 조회로 idempotent 보장).
// 판정 결과를 bnf_market_regime에 저장하고, 수신 설정을 켠 사용자에게 텔레그램으로 발송한다.
import { createClient } from '@supabase/supabase-js';
import type { Candle } from '../../src/lib/types';
import { judgeBothMarkets, regimeIcon, regimeLabel, type Regime } from '../../src/lib/marketRegime';
import { recommendLine } from '../../src/lib/strategyRecommend';
import { kstNow } from '../../src/lib/market-hours';

export const config = { schedule: '*/10 * * * *' };

const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

async function fetchCandlesServer(symbol: string, interval: string, range: string): Promise<Candle[]> {
  let lastErr: unknown;
  for (const host of YAHOO_HOSTS) {
    try {
      const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BNFStudio/1.0)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error(json?.chart?.error?.description ?? 'no data');
      const ts: number[] = result.timestamp ?? [];
      const q = result.indicators?.quote?.[0] ?? {};
      const out: Candle[] = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
        if (o == null || h == null || l == null || c == null) continue;
        out.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
      }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function tgSend(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    return (await r.json())?.ok === true;
  } catch { return false; }
}

type Session = 'preopen' | 'midday' | 'close';
const SESSION_WINDOWS: { session: Session; hour: number; minute: number }[] = [
  { session: 'preopen', hour: 8, minute: 30 },
  { session: 'midday', hour: 11, minute: 0 },
  { session: 'close', hour: 15, minute: 30 },
];

function currentSession(): Session | null {
  const k = kstNow();
  if (k.weekday === 0 || k.weekday === 6) return null; // 주말 스킵
  const mins = k.hour * 60 + k.minute;
  for (const w of SESSION_WINDOWS) {
    const target = w.hour * 60 + w.minute;
    if (Math.abs(mins - target) <= 5) return w.session;
  }
  return null;
}

export default async () => {
  const session = currentSession();
  if (!session) return new Response('skip: not a judging window');

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Response('skip: env missing');
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const k = kstNow();
  const tradeDate = k.dateStr;

  // 이미 이 세션 판정이 있으면 스킵 (idempotent)
  const { data: existing } = await sb.from('bnf_market_regime')
    .select('id').eq('trade_date', tradeDate).eq('session', session).maybeSingle();
  if (existing) return new Response('skip: already judged');

  // 히스테리시스용 직전 판정
  const { data: prevRow } = await sb.from('bnf_market_regime')
    .select('kospi_regime, kosdaq_regime').order('judged_at', { ascending: false }).limit(1).maybeSingle();
  const prevKospi = (prevRow?.kospi_regime as Regime | undefined) ?? undefined;
  const prevKosdaq = (prevRow?.kosdaq_regime as Regime | undefined) ?? undefined;

  let kospi, kosdaq;
  try {
    ({ kospi, kosdaq } = await judgeBothMarkets(fetchCandlesServer, prevKospi, prevKosdaq));
  } catch (e) {
    console.log('[regime] 판정 실패:', e instanceof Error ? e.message : e);
    return new Response('error: judge failed', { status: 500 });
  }

  await sb.from('bnf_market_regime').insert({
    session, trade_date: tradeDate,
    kospi_regime: kospi.regime, kosdaq_regime: kosdaq.regime,
    detail: { kospi, kosdaq },
  });

  // ── 텔레그램 발송 (수신 설정 켠 사용자만) ──
  const { data: profiles } = await sb.from('bnf_profiles').select('id, settings');
  const sessionField = session === 'preopen' ? 'preopen' : session === 'midday' ? 'midday' : 'close';
  const evLine = (label: string, ev: { label: string; met: boolean; value: string }[]) => {
    const met = ev.filter((e) => e.met).map((e) => e.label).join(', ');
    return `${label}: ${met || '(충족 조건 없음)'}`;
  };

  const bodyLines = [
    `${regimeIcon(kospi.regime)} <b>[시장국면] ${session === 'preopen' ? '장전' : session === 'midday' ? '장중' : '장마감'}</b>`,
    `KOSPI: ${regimeIcon(kospi.regime)} ${regimeLabel(kospi.regime)} (${Math.round(kospi.price).toLocaleString('ko-KR')})`,
    `KOSDAQ: ${regimeIcon(kosdaq.regime)} ${regimeLabel(kosdaq.regime)} (${Math.round(kosdaq.price).toLocaleString('ko-KR')})`,
    evLine('근거(KOSPI)', kospi.evidence),
    recommendLine(kospi.regime),
  ];
  const text = bodyLines.join('\n');

  let sent = 0;
  for (const p of profiles ?? []) {
    const settings = (p as { settings?: Record<string, unknown> }).settings ?? {};
    const tg = (settings.telegram ?? {}) as { botToken?: string; chatId?: string };
    const rn = (settings.telegram as Record<string, unknown> | undefined)?.regimeNotify as
      { enabled?: boolean; preopen?: boolean; midday?: boolean; close?: boolean } | undefined;
    if (!tg.botToken || !tg.chatId || !rn?.enabled) continue;
    if (!rn[sessionField]) continue;
    if (await tgSend(tg.botToken, tg.chatId, text)) sent++;
  }

  console.log(`[regime] ${tradeDate} ${session} KOSPI=${kospi.regime} KOSDAQ=${kosdaq.regime} 발송 ${sent}건`);
  return new Response(`ok: ${session} kospi=${kospi.regime} kosdaq=${kosdaq.regime} sent=${sent}`);
};
