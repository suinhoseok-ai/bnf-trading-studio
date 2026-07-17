// ===== 자동매매 엔진 (Netlify 예약 함수 — 브라우저 없이 24시간 동작) =====
// 장중 10분 주기로 실행. AI를 사용하지 않으며, 전략 엔진의 트리거만으로 주문한다.
// 전략 카드(bnf_trading_strategies) 단위로 완전히 독립 실행 — 각자 자기만의
// 스캔대상(universe)·실행주기(interval_min)·최대보유수(max_positions)·예산(budget)을 가진다.
//
// Flow (사용자별, status='RUNNING'인 전략이 1개 이상 있는 사용자만 처리):
//  1. 장중 확인
//  2. Broker Adapter 연결 (토큰 캐시)
//  3. [매도] 보유 전략 포지션 전체 → 전략 stepOpen 트리거 → 시장가 매도 (전략 실행상태와 무관하게 항상 수행)
//  4. [매수] RUNNING 전략별로 자기 주기 스로틀링 → 유니버스 스캔 → 매수 트리거 → 전략 예산 내 점수가중 배분 시장가 매수
//  5. 거래이력·로그 DB 저장 + 텔레그램 알림
//
// 필요한 환경변수: SUPABASE_URL(또는 VITE_), SUPABASE_SERVICE_ROLE_KEY, (권장) BROKER_ENC_KEY
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Candle } from '../../src/lib/types';
import { getStrategy } from '../../src/lib/strategies';
import type { StratRow, OpenPos } from '../../src/lib/strategies/types';
import { starsFromScore } from '../../src/lib/strategies/engine';
import { universeStocks } from '../../src/lib/marketData';
import { isKoreanMarketOpen, kstNow } from '../../src/lib/market-hours';
import { getAdapter, decryptSecret, toKrCode, BrokerAdapter, BrokerCredentials, TokenCache } from '../../src/lib/broker';
import { judgeMarket, type Regime } from '../../src/lib/marketRegime';

export const config = { schedule: '*/10 * * * *' };

const UNIVERSE_CAP = 25;      // 회당 매수 스캔 종목 상한 (함수 실행시간 보호)
const MAX_BUYS_PER_RUN = 5;   // 회당 신규 매수 상한 (다중 전략 병행 실행 고려 상향)
const BATCH = 6;

const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

/** KIS API rate limit(초당 거래건수 초과) 대응: 지수 백오프 재시도 */
async function withKisRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isRateLimit = msg.includes('초당 거래건수') || msg.includes('429') || msg.includes('Too Many');
      if (isRateLimit && i < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, (i + 1) * 800));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Max retries exceeded');
}

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
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function tgSend(token: string, chatId: string, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* 알림 실패는 매매에 영향 주지 않음 */ }
}

interface SettingsRow {
  user_id: string; broker: string; mode: 'paper' | 'real';
  app_key: string; app_secret: string; account_no: string; account_product_cd: string;
  token: TokenCache;
  rg_daily_loss_enabled: boolean; rg_daily_loss_pct: number;
  rg_circuit_enabled: boolean; rg_circuit_drop_pct: number; rg_circuit_block_hours: number; rg_circuit_until: string | null;
  rg_streak_enabled: boolean; rg_streak_losses: number; rg_streak_block_hours: number;
  rg_symbol_cooldown_enabled: boolean; rg_symbol_cooldown_hours: number;
  rg_bear_major_liquidate: boolean;
}

interface StrategyRow {
  id: number; strategy_code: string; universe: string;
  interval_min: number; max_positions: number; budget: number; last_run_at: string | null;
}

export default async () => {
  if (!isKoreanMarketOpen()) return new Response('skip: market closed');

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.log('[trader] env 미설정'); return new Response('skip: env'); }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  // 처리 대상 = RUNNING 전략이 있는 사용자 ∪ 보유 포지션이 있는 사용자.
  // 전략이 ERROR/STOPPED 상태가 되어도 이미 열린 포지션의 손절/익절 매도 감시는 계속되어야 하므로
  // 매도 로직 진입 여부를 전략 실행상태에 의존하지 않게 한다.
  const { data: activeStrats } = await sb.from('bnf_trading_strategies').select('user_id').eq('status', 'RUNNING');
  const { data: openPosUsers } = await sb.from('bnf_live_positions').select('user_id').eq('status', 'OPEN');
  const uids = [...new Set([
    ...(activeStrats ?? []).map((s) => s.user_id as string),
    ...(openPosUsers ?? []).map((p) => p.user_id as string),
  ])];
  if (!uids.length) return new Response('skip: no active traders');

  const now = Date.now();
  const results: string[] = [];
  // 캔들 캐시 (동일 심볼·주기 재사용)
  const candleCache = new Map<string, Candle[]>();
  const getCandles = async (symbol: string, interval: string, range: string) => {
    const k = `${symbol}|${interval}`;
    const hit = candleCache.get(k);
    if (hit) return hit;
    const c = await fetchCandlesServer(symbol, interval, range);
    candleCache.set(k, c);
    return c;
  };

  // 시장국면 게이트: 이번 회차 매수 트리거 판단에 사용할 KOSPI 국면(1회만 조회, 실패 시 게이트 없이 진행)
  let currentRegime: Regime | null = null;
  try {
    const { data: regimeRow } = await sb.from('bnf_market_regime')
      .select('kospi_regime').order('judged_at', { ascending: false }).limit(1).maybeSingle();
    currentRegime = (regimeRow?.kospi_regime as Regime | undefined)
      ?? (await judgeMarket(fetchCandlesServer, '^KS11', 'KOSPI')).regime;
  } catch { /* 게이트 없이 진행 (판정 실패는 매수를 막지 않음) */
  };

  // 서킷브레이커용 KOSPI 당일 등락률 (1회만 조회, 실패 시 null → 서킷브레이커 미작동)
  let kospiChangePct: number | null = null;
  try {
    const idx = await fetchCandlesServer('^KS11', '1d', '5d');
    if (idx.length >= 2) {
      const prevClose = idx[idx.length - 2].close;
      const last = idx[idx.length - 1].close;
      if (prevClose > 0) kospiChangePct = ((last - prevClose) / prevClose) * 100;
    }
  } catch { /* 조회 실패 시 서킷브레이커 게이트 없이 진행 */ }

  for (const uid of uids) {
    const log = (level: string, event: string, detail: string) =>
      sb.from('bnf_trade_logs').insert({ user_id: uid, level, event, detail });

    const { data: settingsData } = await sb.from('bnf_trading_settings').select('*').eq('user_id', uid).maybeSingle();
    const raw = settingsData as SettingsRow | null;
    if (!raw) { await log('warn', '자동매매 스킵', '거래소 연결 설정이 없습니다.'); continue; }

    // 텔레그램 설정 (체결 알림용)
    const { data: prof } = await sb.from('bnf_profiles').select('settings').eq('id', uid).maybeSingle();
    const tg = (prof?.settings as Record<string, Record<string, unknown>> | null)?.telegram ?? {};
    const notify = (text: string) => {
      if (tg.botToken && tg.chatId) return tgSend(String(tg.botToken), String(tg.chatId), text);
      return Promise.resolve();
    };

    try {
      const creds: BrokerCredentials = {
        appKey: decryptSecret(raw.app_key), appSecret: decryptSecret(raw.app_secret),
        accountNo: raw.account_no, accountProductCd: raw.account_product_cd || '01', mode: raw.mode,
      };
      const adapter: BrokerAdapter = getAdapter(raw.broker, creds, raw.token ?? {}, async (t) => {
        await sb.from('bnf_trading_settings').update({ token: t }).eq('user_id', uid);
      });
      await adapter.connect();

      const modeTag = raw.mode === 'real' ? '실전' : '모의';

      // 이 사용자의 실행 중(RUNNING) + 예산 설정된 전략 카드 (완전 독립 실행 단위)
      const { data: stratRows } = await sb.from('bnf_trading_strategies')
        .select('id, strategy_code, universe, interval_min, max_positions, budget, last_run_at')
        .eq('user_id', uid).eq('status', 'RUNNING').gt('budget', 0);
      const strategies = (stratRows ?? []) as StrategyRow[];

      // ── 1. 매도 트리거 (보유 전략 포지션) ──
      // 계좌 요약 + 보유 포지션을 단일 API 호출로 함께 조회 (KIS 초당 요청수 제한 대응)
      const { data: openPos } = await sb.from('bnf_live_positions').select('*').eq('user_id', uid).eq('status', 'OPEN');
      const balance = await withKisRetry(() => adapter.getBalance());
      const brokerPositions = balance.positions;
      const account = balance.account;
      const brokerQty = new Map(brokerPositions.map((p) => [p.symbol, p.sellableQty]));

      for (const pos of openPos ?? []) {
        const p = pos as { id: number; symbol: string; name: string; strategy_code: string; entry_price: number; shares: number; sl: number; tp1_hit: boolean; opened_at: string };
        try {
          const pmod = getStrategy(p.strategy_code || 'bnf1');
          await pmod.init?.(fetchCandlesServer);
          const candles = await getCandles(p.symbol, pmod.interval, pmod.range);
          const stratRows: StratRow[] = pmod.compute(candles);
          const last = stratRows[stratRows.length - 1];
          if (!last) continue;

          const state: OpenPos = {
            symbol: p.symbol, name: p.name, entry_price: Number(p.entry_price),
            shares: Number(p.shares), sl: Number(p.sl), tp1_hit: p.tp1_hit, opened_at: p.opened_at,
          };
          let { events, updated } = pmod.stepOpen(state, last);
          // openbrk(시가돌파 단타)는 당일 청산 전략이므로 15:20 이후엔 잔여 물량을 무조건 시장가 전량 청산
          if ((p.strategy_code || 'bnf1') === 'openbrk' && updated != null) {
            const k = kstNow();
            if (k.hour > 15 || (k.hour === 15 && k.minute >= 20)) {
              events = [{
                side: 'SELL_TP2', price: last.close, shares: updated.shares,
                pnl: updated.shares * (last.close - updated.entry_price), note: '장마감 임박 강제 전량 청산 (15:20)', time: last.time,
              }];
              updated = null;
            }
          }
          if (events.length === 0) continue;

          const code = toKrCode(p.symbol);
          const held = brokerQty.get(code) ?? 0;

          for (const ev of events) {
            const qty = Math.min(Math.floor(ev.shares), held);
            if (qty < 1) {
              await log('warn', '매도 스킵', `${p.name}: 거래소 매도가능수량 부족 (전략 ${Math.floor(ev.shares)}주 vs 보유 ${held}주)`);
              continue;
            }
            const r = await withKisRetry(() => adapter.placeSellOrder(p.symbol, qty, 0)); // 시장가
            const estPnl = qty * (last.close - Number(p.entry_price));
            await sb.from('bnf_live_trades').insert({
              user_id: uid, broker: raw.broker, mode: raw.mode, symbol: p.symbol, name: p.name,
              strategy_code: p.strategy_code, side: ev.side, trigger_note: ev.note,
              order_type: 'market', order_price: ev.price, qty, pnl: estPnl,
              order_no: r.orderNo ?? '', status: r.ok ? 'SUBMITTED' : 'FAILED',
            });
            await log(r.ok ? 'info' : 'error', `매도 트리거 (${ev.side})`,
              `${p.name} ${qty}주 · ${ev.note} → ${r.ok ? `접수 ${r.orderNo}` : `실패: ${r.message}`}`);
            if (r.ok) {
              await notify(`🔻 <b>[자동매매·${modeTag}] 매도 주문</b>\n${p.name} ${qty}주 (시장가)\n사유: ${ev.note}\n추정손익: ${Math.round(estPnl).toLocaleString('ko-KR')}원`);
            }
          }
          // 전략 상태 갱신
          if (updated == null) {
            await sb.from('bnf_live_positions').update({ status: 'CLOSED', closed_at: new Date().toISOString() }).eq('id', p.id);
          } else if (events.length > 0) {
            await sb.from('bnf_live_positions').update({ shares: updated.shares, sl: updated.sl, tp1_hit: updated.tp1_hit }).eq('id', p.id);
          }
        } catch (e) {
          await log('error', '매도 처리 오류', `${p.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // ── 리스크 가드 평가 (신규 매수만 차단, 매도는 위에서 이미 항상 수행됨) ──
      let rgBlockAll: string | null = null; // 사유 문자열이 있으면 이번 회차 전 전략 매수 차단

      // ② 서킷브레이커: KOSPI 당일 급락 시 일정 시간 신규 매수 차단
      if (raw.rg_circuit_enabled) {
        const untilMs = raw.rg_circuit_until ? new Date(raw.rg_circuit_until).getTime() : 0;
        if (kospiChangePct != null && kospiChangePct <= -raw.rg_circuit_drop_pct && untilMs < now) {
          const newUntil = new Date(now + raw.rg_circuit_block_hours * 3600_000).toISOString();
          await sb.from('bnf_trading_settings').update({ rg_circuit_until: newUntil }).eq('user_id', uid);
          raw.rg_circuit_until = newUntil;
          await log('warn', '서킷브레이커 발동', `KOSPI 당일 ${kospiChangePct.toFixed(2)}% 급락 → ${raw.rg_circuit_block_hours}시간 신규 매수 차단`);
          await notify(`🚨 <b>[자동매매·${modeTag}] 서킷브레이커 발동</b>\nKOSPI 당일 ${kospiChangePct.toFixed(2)}% 급락\n${raw.rg_circuit_block_hours}시간 동안 모든 전략 신규 매수를 차단합니다.`);
        }
        if (raw.rg_circuit_until && new Date(raw.rg_circuit_until).getTime() > now) {
          rgBlockAll = `서킷브레이커 발동 중 (${new Date(raw.rg_circuit_until).toLocaleString('ko-KR')}까지 차단)`;
        }
      }

      // ① 일일 손실 한도: 당일(KST) 실현손익 합이 전략 예산 합계의 -N% 이하면 당일 신규 매수 중지
      if (!rgBlockAll && raw.rg_daily_loss_enabled && strategies.length > 0) {
        const kNow = kstNow();
        const kstMidnightIso = new Date(Date.UTC(kNow.year, kNow.month - 1, kNow.day) - 9 * 3600_000).toISOString();
        const { data: todaySells } = await sb.from('bnf_live_trades')
          .select('pnl').eq('user_id', uid).neq('side', 'BUY').gte('executed_at', kstMidnightIso);
        const todayPnl = (todaySells ?? []).reduce((sum, t) => sum + Number((t as { pnl: number }).pnl), 0);
        const totalBudget = strategies.reduce((sum, s) => sum + Number(s.budget), 0);
        if (totalBudget > 0 && todayPnl <= -(totalBudget * raw.rg_daily_loss_pct / 100)) {
          rgBlockAll = `일일 손실 한도 도달 (당일 손익 ${Math.round(todayPnl).toLocaleString('ko-KR')}원 ≤ -${raw.rg_daily_loss_pct}%)`;
        }
      }

      if (rgBlockAll) {
        await log('warn', '리스크가드 매수 차단', rgBlockAll);
      }

      // ④ 동일 종목 재진입 쿨다운: 최근 손절된 종목은 일정 시간 어느 전략도 재매수 금지
      const cooldownSymbols = new Set<string>();
      if (raw.rg_symbol_cooldown_enabled) {
        const cutoffIso = new Date(now - raw.rg_symbol_cooldown_hours * 3600_000).toISOString();
        const { data: recentStops } = await sb.from('bnf_live_trades')
          .select('symbol').eq('user_id', uid).eq('side', 'SELL_SL').gte('executed_at', cutoffIso);
        for (const r of recentStops ?? []) cooldownSymbols.add(toKrCode((r as { symbol: string }).symbol));
      }

      // ③ 연속 손절 쿨다운: 전략별 최근 매도 N회가 모두 손실이면 그 전략만 일정 시간 매수 정지
      const streakBlockedStrategies = new Map<string, string>(); // strategy_code -> 사유
      if (!rgBlockAll && raw.rg_streak_enabled) {
        for (const strat of strategies) {
          const { data: recentSells } = await sb.from('bnf_live_trades')
            .select('pnl, executed_at').eq('user_id', uid).eq('strategy_code', strat.strategy_code)
            .neq('side', 'BUY').order('executed_at', { ascending: false }).limit(raw.rg_streak_losses);
          const rows = (recentSells ?? []) as { pnl: number; executed_at: string }[];
          if (rows.length >= raw.rg_streak_losses && rows.every((r) => Number(r.pnl) < 0)) {
            const lastLossMs = new Date(rows[0].executed_at).getTime();
            if (now - lastLossMs < raw.rg_streak_block_hours * 3600_000) {
              streakBlockedStrategies.set(strat.strategy_code, `${raw.rg_streak_losses}연속 손절 쿨다운 (${raw.rg_streak_block_hours}시간)`);
            }
          }
        }
      }

      // ── 2. 매수 트리거 (전략 카드별 완전 독립 실행: 자기 주기·유니버스·최대보유수·예산) ──
      let buys = 0;
      const heldSymbols = new Set([
        ...brokerPositions.map((p) => p.symbol),
        ...(openPos ?? []).map((p) => toKrCode((p as { symbol: string }).symbol)),
        ...cooldownSymbols,
      ]);

      for (const strat of strategies) {
        if (rgBlockAll) break;
        const streakReason = streakBlockedStrategies.get(strat.strategy_code);
        if (streakReason) {
          await log('info', '매수 스킵', `${strat.strategy_code}: ${streakReason}`);
          continue;
        }
        if (buys >= MAX_BUYS_PER_RUN) break;
        // 전략별 실행주기 스로틀링
        if (strat.last_run_at && now - new Date(strat.last_run_at).getTime() < Math.max(10, strat.interval_min) * 60_000 - 30_000) continue;

        const stratLog = (level: string, event: string, detail: string) => log(level, event, detail);
        try {
          const mod = getStrategy(strat.strategy_code);

          // 시장국면 게이트: 전략의 적정 장세와 현재 KOSPI 국면이 다르면 신규 매수 스킵 (매도는 항상 수행되므로 영향 없음)
          if (currentRegime && mod.regime !== 'ANY' && mod.regime !== currentRegime) {
            await stratLog('info', '매수 스킵', `${mod.name}: 시장 국면 불일치 (전략 적정장세=${mod.regime}, 현재=${currentRegime})`);
            continue;
          }

          await mod.init?.(fetchCandlesServer);

          // 이 전략카드의 현재 보유 종목 수 → 슬롯 = 최대보유수 - 보유중
          const strategyOpenCount = (openPos ?? []).filter((p) => (p as { strategy_code: string }).strategy_code === strat.strategy_code).length;
          let slots = Math.max(0, strat.max_positions - strategyOpenCount);

          // 이 전략으로 현재 보유 중인 금액(투입액) → 잔여 예산 = 전략 예산 - 투입액
          const invested = (openPos ?? [])
            .filter((p) => (p as { strategy_code: string }).strategy_code === strat.strategy_code)
            .reduce((sum, p) => sum + Number((p as { entry_price: number }).entry_price) * Number((p as { shares: number }).shares), 0);
          const remainingBudget = Math.max(0, strat.budget - invested);

          if (slots <= 0 || remainingBudget < 1) {
            await stratLog('info', '매수 스킵', `${mod.name}: ${slots <= 0 ? '최대 보유 종목 수 도달' : `전략 예산 소진 (예산 ${Math.round(strat.budget).toLocaleString('ko-KR')}원, 투입 ${Math.round(invested).toLocaleString('ko-KR')}원)`}`);
          } else {
            let cash = account.cash;
            const stocks = universeStocks(strat.universe || 'KOSPI').slice(0, UNIVERSE_CAP);

            // 신호 수집 (배치) — 점수(score)까지 함께 계산해 배분 비중으로 사용
            const signals: { symbol: string; name: string; rows: StratRow[]; score: number }[] = [];
            for (let i = 0; i < stocks.length; i += BATCH) {
              await Promise.all(stocks.slice(i, i + BATCH).map(async (s) => {
                if (heldSymbols.has(toKrCode(s.symbol))) return;
                try {
                  const candles = await getCandles(s.symbol, mod.interval, mod.range);
                  if (candles.length < 30) return;
                  const rs = mod.compute(candles);
                  if (!rs[rs.length - 1]?.buy) return;
                  const scan = mod.scan(s.symbol, s.name, rs);
                  signals.push({ symbol: s.symbol, name: s.name, rows: rs, score: scan.score });
                } catch { /* skip */ }
              }));
            }

            if (signals.length > 0) {
              // 같은 회차에 잡힌 신호들 = 전략 잔여예산을 점수(추천도) 비중으로 배분
              const totalScore = signals.reduce((sum, x) => sum + Math.max(1, x.score), 0);

              for (const sig of signals) {
                if (slots <= 0 || buys >= MAX_BUYS_PER_RUN) break;
                const lastRow = sig.rows[sig.rows.length - 1];
                // planEntry에서는 손절가(sl)·트리거 설명만 사용, 수량은 점수가중 배분 예산으로 별도 계산
                const plan = mod.planEntry(sig.rows, sig.rows.length - 1, cash);
                if (!plan) continue;
                const weight = Math.max(1, sig.score) / totalScore;
                const alloc = Math.min(remainingBudget * weight, cash);
                // 트리거 판단은 Yahoo(지연) 캔들 기준이지만, 수량은 체결 직전 KIS 실시간가로 계산 +
                // 2% 안전마진(가격 변동·수수료 여유분)을 둬서 "주문가능금액 초과" 실패를 방지한다.
                let sizingPrice = lastRow.close;
                try {
                  const rt = await withKisRetry(() => adapter.getMarketPrice(sig.symbol));
                  if (rt > 0) sizingPrice = rt;
                } catch { /* 실시간가 조회 실패 시 Yahoo 종가로 폴백 */ }
                const qty = Math.floor((alloc * 0.98) / sizingPrice);
                if (qty < 1) { await stratLog('warn', '매수 스킵', `${sig.name}: 배분 예산 부족 (배분액 ${Math.round(alloc).toLocaleString('ko-KR')}원 < 1주, 점수 ${sig.score}·★${starsFromScore(sig.score)})`); continue; }

                const r = await withKisRetry(() => adapter.placeBuyOrder(sig.symbol, qty, 0)); // 시장가
                await sb.from('bnf_live_trades').insert({
                  user_id: uid, broker: raw.broker, mode: raw.mode, symbol: sig.symbol, name: sig.name,
                  strategy_code: mod.code, side: 'BUY', trigger_note: plan.note,
                  order_type: 'market', order_price: lastRow.close, qty,
                  order_no: r.orderNo ?? '', status: r.ok ? 'SUBMITTED' : 'FAILED',
                });
                await stratLog(r.ok ? 'info' : 'error', '매수 트리거',
                  `${sig.name} ${qty}주 @~${Math.round(lastRow.close).toLocaleString('ko-KR')} · 점수 ${sig.score}(★${starsFromScore(sig.score)}) · ${plan.note} → ${r.ok ? `접수 ${r.orderNo}` : `실패: ${r.message}`}`);
                if (r.ok) {
                  await sb.from('bnf_live_positions').insert({
                    user_id: uid, broker: raw.broker, symbol: sig.symbol, name: sig.name,
                    strategy_code: mod.code, entry_price: lastRow.close, shares: qty,
                    sl: plan.sl, tp1_hit: false, order_no: r.orderNo ?? '',
                  });
                  await notify(`🟢 <b>[자동매매·${modeTag}] 매수 주문</b>\n${sig.name} ${qty}주 (시장가 ~${Math.round(lastRow.close).toLocaleString('ko-KR')}원)\n전략: ${mod.name.split('·')[0].trim()} (점수 ${sig.score}·★${starsFromScore(sig.score)})\n${plan.note}`);
                  cash -= qty * lastRow.close;
                  account.cash = cash;
                  heldSymbols.add(toKrCode(sig.symbol));
                  slots--; buys++;
                }
              }
            }
          }

          await sb.from('bnf_trading_strategies').update({
            last_run_at: new Date().toISOString(), last_error: '', updated_at: new Date().toISOString(),
          }).eq('id', strat.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await sb.from('bnf_trading_strategies').update({
            status: 'ERROR', last_error: msg, last_run_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }).eq('id', strat.id);
          await stratLog('error', '전략 실행 오류', `${strat.strategy_code}: ${msg}`);
        }
      }

      results.push(`${uid.slice(0, 8)}:ok(buys=${buys})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await sb.from('bnf_trading_strategies').update({
        status: 'ERROR', last_error: msg, updated_at: new Date().toISOString(),
      }).eq('user_id', uid).eq('status', 'RUNNING');
      await log('error', '자동매매 실행 오류', msg);
      await notify(`⚠️ <b>[자동매매] 오류로 일시 중지</b>\n${msg}\n웹 자동매매 페이지에서 확인 후 다시 시작하세요.`);
      results.push(`${uid.slice(0, 8)}:error`);
    }
  }

  console.log('[trader]', results.join(' '));
  return new Response(results.join(' ') || 'skip');
};
