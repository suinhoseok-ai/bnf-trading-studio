// ===== 시장국면 판정 스케줄 함수 v2 (5국면 + 확정 상태머신) =====
// 10분마다 실행되지만 실제 판정은 KST 08:30(preopen)/11:00(midday)/15:30(close) ±5분 창에서만,
// 세션당 1회만 수행한다(unique(trade_date,session) + 사전 조회로 idempotent 보장).
//
// 확정(confirmed) 규칙:
//  - preopen: 직전 거래일 확정상태를 불러와 stabilize()로 새 확정을 만든다 (하루 1회 확정).
//  - midday/close: 당일 preopen 확정을 그대로 승계하고 candidate/신뢰도/비상감지만 갱신한다.
//    (preopen 기록이 없으면 그 세션에서 확정까지 수행 — 함수 다운 대비 폴백)
import { createClient } from '@supabase/supabase-js';
import type { Candle } from '../../src/lib/types';
import { classifyFromCandles, stabilize, regimeIcon, regimeLabel, type Regime, type RiskState, type RegimeResult } from '../../src/lib/marketRegime';
import { recommendLine } from '../../src/lib/strategyRecommend';
import { universeStocks } from '../../src/lib/marketData';
import { smaAt } from '../../src/lib/strategies/engine';
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

/** 시장폭: 유니버스 주요종목 중 종가>SMA50 비율 (best-effort, 유효종목<10이면 null) */
async function computeBreadth(universeKey: string): Promise<number | null> {
  try {
    const stocks = universeStocks(universeKey);
    let above = 0, valid = 0;
    for (let i = 0; i < stocks.length; i += 6) {
      await Promise.all(stocks.slice(i, i + 6).map(async (s) => {
        try {
          const c = await fetchCandlesServer(s.symbol, '1d', '1y');
          const closes = c.map((x) => x.close);
          const j = closes.length - 1;
          const sma50 = smaAt(closes, 50, j);
          if (sma50 != null && closes[j] > 0) { valid++; if (closes[j] > sma50) above++; }
        } catch { /* 개별 종목 실패 무시 */ }
      }));
    }
    return valid >= 10 ? above / valid : null;
  } catch { return null; }
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

interface StoredRow {
  kospi_regime: Regime; kosdaq_regime: Regime;
  kospi_candidate: Regime | null; kosdaq_candidate: Regime | null;
  confirmation_streak: number; trade_date: string;
  detail: { kospiStreak?: number; kosdaqStreak?: number } | null;
}

/** 두 리스크 상태 중 더 심각한 쪽 (EMERGENCY > DATA_INVALID > NORMAL) */
function worseRisk(a: RiskState, b: RiskState): RiskState {
  const rank = (r: RiskState) => (r === 'EMERGENCY_RISK_OFF' ? 2 : r === 'DATA_INVALID' ? 1 : 0);
  return rank(a) >= rank(b) ? a : b;
}

export default async () => {
  const session = currentSession();
  if (!session) return new Response('skip: not a judging window');

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Response('skip: env missing');
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const tradeDate = kstNow().dateStr;

  // 이미 이 세션 판정이 있으면 스킵 (idempotent)
  const { data: existing } = await sb.from('bnf_market_regime')
    .select('id').eq('trade_date', tradeDate).eq('session', session).maybeSingle();
  if (existing) return new Response('skip: already judged');

  // ── 판정 (breadth 병행 계산) ──
  let kospi: RegimeResult, kosdaq: RegimeResult;
  try {
    const [kBreadth, qBreadth] = await Promise.all([computeBreadth('KOSPI'), computeBreadth('KOSDAQ')]);
    const [kCandles, qCandles] = await Promise.all([
      fetchCandlesServer('^KS11', '1d', '2y'),
      fetchCandlesServer('^KQ11', '1d', '2y'),
    ]);
    kospi = classifyFromCandles(kCandles, 'KOSPI', kBreadth);
    kosdaq = classifyFromCandles(qCandles, 'KOSDAQ', qBreadth);
  } catch (e) {
    console.log('[regime] 판정 실패:', e instanceof Error ? e.message : e);
    return new Response('error: judge failed', { status: 500 });
  }

  // ── 확정 상태 결정 ──
  let kConfirmed: Regime, qConfirmed: Regime, kStreak: number, qStreak: number;

  const todayPre = session !== 'preopen'
    ? (await sb.from('bnf_market_regime').select('*').eq('trade_date', tradeDate).order('judged_at', { ascending: true }).limit(1).maybeSingle()).data as StoredRow | null
    : null;

  if (todayPre) {
    // midday/close: 당일 확정 승계 (candidate/신뢰도만 새로 계산)
    kConfirmed = todayPre.kospi_regime; qConfirmed = todayPre.kosdaq_regime;
    kStreak = todayPre.detail?.kospiStreak ?? todayPre.confirmation_streak ?? 0;
    qStreak = todayPre.detail?.kosdaqStreak ?? 0;
  } else {
    // preopen (또는 preopen 누락 폴백): 직전 거래일 상태로 stabilize
    const { data: priorArr } = await sb.from('bnf_market_regime')
      .select('*').lt('trade_date', tradeDate)
      .order('trade_date', { ascending: false }).order('judged_at', { ascending: false }).limit(1);
    const prior = (priorArr?.[0] ?? null) as StoredRow | null;
    const prevKConfirmed = (prior?.kospi_regime as Regime) ?? 'TRANSITION';
    const prevQConfirmed = (prior?.kosdaq_regime as Regime) ?? 'TRANSITION';
    const prevKCandidate = (prior?.kospi_candidate as Regime) ?? prevKConfirmed;
    const prevQCandidate = (prior?.kosdaq_candidate as Regime) ?? prevQConfirmed;
    const prevKStreak = prior?.detail?.kospiStreak ?? prior?.confirmation_streak ?? 0;
    const prevQStreak = prior?.detail?.kosdaqStreak ?? 0;

    const kStab = stabilize(kospi.candidate, prevKConfirmed, prevKCandidate, prevKStreak,
      prevKConfirmed !== 'TRANSITION' && kospi.flags[prevKConfirmed as Exclude<Regime, 'TRANSITION'>]);
    const qStab = stabilize(kosdaq.candidate, prevQConfirmed, prevQCandidate, prevQStreak,
      prevQConfirmed !== 'TRANSITION' && kosdaq.flags[prevQConfirmed as Exclude<Regime, 'TRANSITION'>]);
    kConfirmed = kStab.confirmed; kStreak = kStab.streak;
    qConfirmed = qStab.confirmed; qStreak = qStab.streak;
  }

  const riskState = worseRisk(kospi.riskState, kosdaq.riskState);

  await sb.from('bnf_market_regime').insert({
    session, trade_date: tradeDate,
    kospi_regime: kConfirmed, kosdaq_regime: qConfirmed,
    kospi_candidate: kospi.candidate, kosdaq_candidate: kosdaq.candidate,
    confidence: kospi.confidence, confirmation_streak: kStreak, risk_state: riskState,
    detail: { kospi, kosdaq, kospiStreak: kStreak, kosdaqStreak: qStreak },
  });

  // ── 텔레그램 발송 (수신 설정 켠 사용자만) ──
  const { data: profiles } = await sb.from('bnf_profiles').select('id, settings');
  const { data: stratRows } = await sb.from('bnf_strategies').select('code').order('sort_order').order('id');
  const strategyOrder = (stratRows ?? []).map((s) => s.code as string);
  const sessionLabel = session === 'preopen' ? '장전' : session === 'midday' ? '장중' : '장마감';
  const metLabels = kospi.evidence.filter((e) => e.met).map((e) => e.label).join(', ');
  const riskBanner = riskState === 'EMERGENCY_RISK_OFF' ? '\n🚨 비상 리스크오프 — 신규 매수 전면 중단'
    : riskState === 'DATA_INVALID' ? '\n⚠️ 시장 데이터 이상 — 신규 매수 중단' : '';

  const text = [
    `${regimeIcon(kConfirmed)} <b>[시장국면] ${sessionLabel}</b>`,
    `KOSPI: ${regimeIcon(kConfirmed)} ${regimeLabel(kConfirmed)} (신뢰도 ${(kospi.confidence * 100).toFixed(0)}%${kStreak > 0 ? ` · 전환대기 ${kStreak}일` : ''})`,
    `KOSDAQ: ${regimeIcon(qConfirmed)} ${regimeLabel(qConfirmed)}`,
    `근거(KOSPI): ${metLabels || '(충족 조건 없음)'}`,
    recommendLine(kConfirmed, strategyOrder),
  ].join('\n') + riskBanner;

  let sent = 0;
  for (const p of profiles ?? []) {
    const settings = (p as { settings?: Record<string, unknown> }).settings ?? {};
    const tg = (settings.telegram ?? {}) as { botToken?: string; chatId?: string };
    const rn = (settings.telegram as Record<string, unknown> | undefined)?.regimeNotify as
      { enabled?: boolean; preopen?: boolean; midday?: boolean; close?: boolean } | undefined;
    if (!tg.botToken || !tg.chatId || !rn?.enabled) continue;
    if (!rn[session]) continue;
    if (await tgSend(tg.botToken, tg.chatId, text)) sent++;
  }

  console.log(`[regime] ${tradeDate} ${session} KOSPI=${kConfirmed}(cand ${kospi.candidate}) KOSDAQ=${qConfirmed} risk=${riskState} 발송 ${sent}`);
  return new Response(`ok: ${session} kospi=${kConfirmed} kosdaq=${qConfirmed} risk=${riskState} sent=${sent}`);
};
