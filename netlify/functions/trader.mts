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
import { isKoreanMarketOpen } from '../../src/lib/market-hours';
import { getAdapter, decryptSecret, toKrCode, BrokerAdapter, BrokerCredentials, TokenCache } from '../../src/lib/broker';

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

  const { data: activeStrats } = await sb.from('bnf_trading_strategies').select('user_id').eq('status', 'RUNNING');
  const uids = [...new Set((activeStrats ?? []).map((s) => s.user_id as string))];
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
          const { events, updated } = pmod.stepOpen(state, last);
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

      // ── 2. 매수 트리거 (전략 카드별 완전 독립 실행: 자기 주기·유니버스·최대보유수·예산) ──
      let buys = 0;
      const heldSymbols = new Set([
        ...brokerPositions.map((p) => p.symbol),
        ...(openPos ?? []).map((p) => toKrCode((p as { symbol: string }).symbol)),
      ]);

      for (const strat of strategies) {
        if (buys >= MAX_BUYS_PER_RUN) break;
        // 전략별 실행주기 스로틀링
        if (strat.last_run_at && now - new Date(strat.last_run_at).getTime() < Math.max(10, strat.interval_min) * 60_000 - 30_000) continue;

        const stratLog = (level: string, event: string, detail: string) => log(level, event, detail);
        try {
          const mod = getStrategy(strat.strategy_code);
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
                const qty = Math.floor(alloc / lastRow.close);
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
