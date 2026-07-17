// ===== 자동매매 브로커 API (인증된 사용자 전용 HTTP 함수) =====
// POST /api/broker  { action, accessToken, ... }
// actions:
//   save-settings  설정 저장 (API 키는 AES-GCM 암호화)
//   save-riskguard 리스크가드 설정 저장 { riskGuard: {...} }
//   get-settings   설정 조회 (키는 마스킹, riskGuard 포함)
//   test           브로커 연결 테스트 (토큰 발급 + 계좌 조회)
//   account        계좌 요약
//   positions      거래소 보유 포지션
//   orders         최근 주문 내역
//   quotes         실시간 시세 스냅샷 { symbols[] } (최대 6개/요청, 서버가 초당제한 맞춰 지연)
//   force-sell     강제매도 { symbol, qty(0=전량), price(0=시장가) }
//   save-strategy  전략 카드 저장 { id?, strategyCode, universe, intervalMin, maxPositions, budget, regimeFilterEnabled }
//   toggle-strategy 전략 카드 시작/중지 { id, running }
//   delete-strategy 전략 카드 삭제 { id }
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getAdapter, encryptSecret, decryptSecret, maskKey, encryptionEnabled, BrokerCredentials, TokenCache } from '../../src/lib/broker';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

interface SettingsRow {
  user_id: string; broker: string; mode: 'paper' | 'real';
  app_key: string; app_secret: string; account_no: string; account_product_cd: string;
  enabled: boolean; status: string; strategy_code: string; universe: string;
  interval_min: number; max_positions: number; budget_pct: number;
  token: TokenCache; last_run_at: string | null; last_error: string;
  rg_daily_loss_enabled: boolean; rg_daily_loss_pct: number;
  rg_circuit_enabled: boolean; rg_circuit_drop_pct: number; rg_circuit_block_hours: number; rg_circuit_until: string | null;
  rg_streak_enabled: boolean; rg_streak_losses: number; rg_streak_block_hours: number;
  rg_symbol_cooldown_enabled: boolean; rg_symbol_cooldown_hours: number;
  rg_bear_major_liquidate: boolean;
}

async function makeAdapter(sb: SupabaseClient, row: SettingsRow) {
  const creds: BrokerCredentials = {
    appKey: decryptSecret(row.app_key),
    appSecret: decryptSecret(row.app_secret),
    accountNo: row.account_no,
    accountProductCd: row.account_product_cd || '01',
    mode: row.mode,
  };
  if (!creds.appKey || !creds.appSecret || !creds.accountNo) {
    throw new Error('API 키/계좌번호가 설정되지 않았습니다. 설정을 먼저 저장하세요.');
  }
  const adapter = getAdapter(row.broker, creds, row.token ?? {}, async (t) => {
    await sb.from('bnf_trading_settings').update({ token: t, updated_at: new Date().toISOString() }).eq('user_id', row.user_id);
  });
  await adapter.connect();
  return adapter;
}

const log = (sb: SupabaseClient, uid: string, level: string, event: string, detail: string) =>
  sb.from('bnf_trade_logs').insert({ user_id: uid, level, event, detail }).then(() => {});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** KIS 초당 거래건수 초과 시 짧게 대기 후 1회 재시도 */
async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('초당 거래건수') || msg.includes('429') || msg.includes('Too Many')) {
      await sleep(1000);
      return fn();
    }
    throw e;
  }
}

export default async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return json({ ok: false, error: '서버 환경변수(SUPABASE_SERVICE_ROLE_KEY) 미설정' }, 500);
  const sb = createClient(url, key, { auth: { persistSession: false } });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const action = String(body.action ?? '');
  const accessToken = String(body.accessToken ?? '');
  if (!accessToken) return json({ ok: false, error: '로그인이 필요합니다.' }, 401);

  const { data: userData, error: userErr } = await sb.auth.getUser(accessToken);
  if (userErr || !userData?.user) return json({ ok: false, error: '인증 실패' }, 401);
  const uid = userData.user.id;

  const loadSettings = async (): Promise<SettingsRow | null> => {
    const { data } = await sb.from('bnf_trading_settings').select('*').eq('user_id', uid).maybeSingle();
    return (data as SettingsRow) ?? null;
  };

  try {
    switch (action) {
      case 'save-settings': {
        const s = (body.settings ?? {}) as Record<string, unknown>;
        const existing = await loadSettings();
        const row: Record<string, unknown> = {
          user_id: uid,
          broker: s.broker === 'toss' ? 'toss' : 'kis',
          mode: s.mode === 'real' ? 'real' : 'paper',
          account_no: String(s.accountNo ?? '').replace(/\D/g, '').slice(0, 8),
          account_product_cd: String(s.accountProductCd ?? '01').replace(/\D/g, '').slice(0, 2) || '01',
          universe: String(s.universe ?? 'KOSPI'),
          interval_min: Math.max(10, Number(s.intervalMin) || 10),
          max_positions: Math.min(20, Math.max(1, Number(s.maxPositions) || 5)),
          updated_at: new Date().toISOString(),
        };
        // 키는 새 값이 입력된 경우에만 갱신 (빈 값이면 기존 유지)
        if (s.appKey) row.app_key = encryptSecret(String(s.appKey).trim());
        if (s.appSecret) row.app_secret = encryptSecret(String(s.appSecret).trim());
        // 브로커/모드가 바뀌면 토큰 캐시 무효화
        if (existing && (existing.broker !== row.broker || existing.mode !== row.mode)) row.token = {};
        const { error } = await sb.from('bnf_trading_settings').upsert(row);
        if (error) return json({ ok: false, error: error.message }, 500);

        await log(sb, uid, 'info', '설정 저장', `${row.broker}/${row.mode}`);
        return json({ ok: true, encryption: encryptionEnabled() });
      }

      case 'save-riskguard': {
        const g = (body.riskGuard ?? {}) as Record<string, unknown>;
        const row: Record<string, unknown> = {
          user_id: uid,
          rg_daily_loss_enabled: !!g.dailyLossEnabled,
          rg_daily_loss_pct: Math.min(50, Math.max(0.1, Number(g.dailyLossPct) || 3)),
          rg_circuit_enabled: !!g.circuitEnabled,
          rg_circuit_drop_pct: Math.min(30, Math.max(0.5, Number(g.circuitDropPct) || 5)),
          rg_circuit_block_hours: Math.min(72, Math.max(1, Number(g.circuitBlockHours) || 12)),
          rg_streak_enabled: !!g.streakEnabled,
          rg_streak_losses: Math.min(10, Math.max(2, Math.floor(Number(g.streakLosses)) || 3)),
          rg_streak_block_hours: Math.min(168, Math.max(1, Number(g.streakBlockHours) || 24)),
          rg_symbol_cooldown_enabled: !!g.symbolCooldownEnabled,
          rg_symbol_cooldown_hours: Math.min(168, Math.max(1, Number(g.symbolCooldownHours) || 24)),
          rg_bear_major_liquidate: !!g.bearMajorLiquidate,
          updated_at: new Date().toISOString(),
        };
        // 계좌 연결 설정이 아직 없으면(브로커 미저장) upsert가 not-null 컬럼에서 실패하므로 먼저 확인
        const existing = await loadSettings();
        if (!existing) return json({ ok: false, error: '거래소 연결 설정을 먼저 저장하세요.' }, 400);
        const { error } = await sb.from('bnf_trading_settings').update(row).eq('user_id', uid);
        if (error) return json({ ok: false, error: error.message }, 500);
        await log(sb, uid, 'info', '리스크가드 설정 저장', JSON.stringify(row));
        return json({ ok: true });
      }

      case 'get-settings': {
        const row = await loadSettings();
        if (!row) return json({ ok: true, settings: null, encryption: encryptionEnabled() });
        const { data: strategies } = await sb.from('bnf_trading_strategies')
          .select('id, strategy_code, universe, interval_min, max_positions, budget, status, last_run_at, last_error, regime_filter_enabled')
          .eq('user_id', uid).order('id', { ascending: true });
        return json({
          ok: true,
          encryption: encryptionEnabled(),
          settings: {
            broker: row.broker, mode: row.mode,
            accountNo: row.account_no, accountProductCd: row.account_product_cd,
            appKeyMasked: maskKey(row.app_key), appSecretSet: !!row.app_secret,
            strategies: (strategies ?? []).map((s) => ({
              id: s.id, strategyCode: s.strategy_code, universe: s.universe,
              intervalMin: s.interval_min, maxPositions: s.max_positions, budget: Number(s.budget),
              status: s.status, lastRunAt: s.last_run_at, lastError: s.last_error,
              regimeFilterEnabled: s.regime_filter_enabled,
            })),
            riskGuard: {
              dailyLossEnabled: row.rg_daily_loss_enabled, dailyLossPct: Number(row.rg_daily_loss_pct),
              circuitEnabled: row.rg_circuit_enabled, circuitDropPct: Number(row.rg_circuit_drop_pct),
              circuitBlockHours: Number(row.rg_circuit_block_hours), circuitUntil: row.rg_circuit_until,
              streakEnabled: row.rg_streak_enabled, streakLosses: row.rg_streak_losses, streakBlockHours: Number(row.rg_streak_block_hours),
              symbolCooldownEnabled: row.rg_symbol_cooldown_enabled, symbolCooldownHours: Number(row.rg_symbol_cooldown_hours),
              bearMajorLiquidate: row.rg_bear_major_liquidate,
            },
          },
        });
      }

      case 'test': {
        const row = await loadSettings();
        if (!row) return json({ ok: false, error: '설정을 먼저 저장하세요.' }, 400);
        const adapter = await makeAdapter(sb, row);
        const account = await adapter.getAccount();
        await log(sb, uid, 'info', '연결 테스트 성공', `${row.broker}/${row.mode}`);
        return json({ ok: true, account });
      }

      case 'account': {
        const row = await loadSettings();
        if (!row) return json({ ok: false, error: '설정 없음' }, 400);
        const adapter = await makeAdapter(sb, row);
        return json({ ok: true, account: await adapter.getAccount() });
      }

      case 'positions': {
        const row = await loadSettings();
        if (!row) return json({ ok: false, error: '설정 없음' }, 400);
        const adapter = await makeAdapter(sb, row);
        return json({ ok: true, positions: await adapter.getPositions() });
      }

      case 'orders': {
        const row = await loadSettings();
        if (!row) return json({ ok: false, error: '설정 없음' }, 400);
        const adapter = await makeAdapter(sb, row);
        return json({ ok: true, orders: await adapter.getOrders(Number(body.days) || 7) });
      }

      case 'quotes': {
        // 실시간 시세 스냅샷 (거래소 직접). 브라우저가 종목을 소량씩 순차 요청하고,
        // 서버는 배치 내에서 KIS 초당 제한에 맞춰 호출 간 지연을 둔다.
        const row = await loadSettings();
        if (!row) return json({ ok: false, error: '거래소 연결 설정을 먼저 저장하세요.' }, 400);
        const symbols = (Array.isArray(body.symbols) ? body.symbols : []).map(String).slice(0, 6);
        if (!symbols.length) return json({ ok: true, quotes: [], mode: row.mode });
        const adapter = await makeAdapter(sb, row);
        // 모의투자는 초당 제한이 훨씬 엄격 → 호출 간 간격을 크게
        const gap = row.mode === 'paper' ? 550 : 120;
        const quotes: Record<string, unknown>[] = [];
        for (let i = 0; i < symbols.length; i++) {
          await sleep(gap); // 배치 경계 포함 항상 선-대기하여 초당 제한 회피
          try {
            quotes.push(await withRateLimitRetry(() => adapter.getQuote(symbols[i])));
          } catch (e) {
            quotes.push({ symbol: symbols[i], error: e instanceof Error ? e.message : String(e) });
          }
        }
        return json({ ok: true, quotes, mode: row.mode });
      }

      case 'force-sell': {
        const row = await loadSettings();
        if (!row) return json({ ok: false, error: '설정 없음' }, 400);
        const symbol = String(body.symbol ?? '');
        let qty = Math.floor(Number(body.qty) || 0);
        const price = Math.floor(Number(body.price) || 0);
        if (!symbol) return json({ ok: false, error: 'symbol 필요' }, 400);

        const adapter = await makeAdapter(sb, row);
        if (qty <= 0) {
          const pos = (await adapter.getPositions()).find((p) => p.symbol === symbol.replace(/\.(KS|KQ)$/i, ''));
          if (!pos || pos.sellableQty < 1) return json({ ok: false, error: '매도 가능 수량이 없습니다.' }, 400);
          qty = pos.sellableQty;
        }
        const r = await adapter.placeSellOrder(symbol, qty, price);
        await sb.from('bnf_live_trades').insert({
          user_id: uid, broker: row.broker, mode: row.mode, symbol, name: String(body.name ?? ''),
          side: 'FORCE_SELL', trigger_note: '사용자 강제매도',
          order_type: price > 0 ? 'limit' : 'market', order_price: price, qty,
          order_no: r.orderNo ?? '', status: r.ok ? 'SUBMITTED' : 'FAILED',
        });
        await log(sb, uid, r.ok ? 'info' : 'error', '강제매도', `${symbol} ${qty}주 → ${r.ok ? `접수(주문번호 ${r.orderNo})` : r.message}`);
        // 우리 전략 포지션 상태도 종결 처리
        if (r.ok) {
          await sb.from('bnf_live_positions').update({ status: 'CLOSED', closed_at: new Date().toISOString() })
            .eq('user_id', uid).eq('status', 'OPEN').or(`symbol.eq.${symbol},symbol.eq.${symbol.replace(/\.(KS|KQ)$/i, '')}`);
        }
        return json(r.ok ? { ok: true, orderNo: r.orderNo } : { ok: false, error: r.message }, r.ok ? 200 : 502);
      }

      case 'save-strategy': {
        const s = (body.strategy ?? {}) as Record<string, unknown>;
        const strategyCode = String(s.strategyCode ?? '');
        if (!strategyCode) return json({ ok: false, error: '매매 전략을 선택하세요.' }, 400);
        const row: Record<string, unknown> = {
          user_id: uid,
          strategy_code: strategyCode,
          universe: String(s.universe ?? 'KOSPI'),
          interval_min: Math.max(10, Number(s.intervalMin) || 10),
          max_positions: Math.min(20, Math.max(1, Number(s.maxPositions) || 5)),
          budget: Math.max(0, Number(s.budget) || 0),
          regime_filter_enabled: s.regimeFilterEnabled !== false,
          updated_at: new Date().toISOString(),
        };
        const id = s.id != null ? Number(s.id) : null;
        if (id) {
          const { error } = await sb.from('bnf_trading_strategies').update(row).eq('id', id).eq('user_id', uid);
          if (error) return json({ ok: false, error: error.message }, 500);
          await log(sb, uid, 'info', '전략 저장', `${strategyCode} (id ${id})`);
          return json({ ok: true, id });
        }
        const { data, error } = await sb.from('bnf_trading_strategies').insert(row).select('id').single();
        if (error) return json({ ok: false, error: error.message }, 500);
        await log(sb, uid, 'info', '전략 추가', strategyCode);
        return json({ ok: true, id: data.id });
      }

      case 'toggle-strategy': {
        const id = Number(body.id);
        const running = !!body.running;
        if (!id) return json({ ok: false, error: '전략을 먼저 저장하세요.' }, 400);
        const { data: strat } = await sb.from('bnf_trading_strategies').select('*').eq('id', id).eq('user_id', uid).maybeSingle();
        if (!strat) return json({ ok: false, error: '전략을 찾을 수 없습니다.' }, 400);
        if (running) {
          if (Number(strat.budget) <= 0) return json({ ok: false, error: '예산을 먼저 설정하세요.' }, 400);
          const settingsRow = await loadSettings();
          if (!settingsRow) return json({ ok: false, error: '거래소 연결 설정을 먼저 저장하세요.' }, 400);
          const adapter = await makeAdapter(sb, settingsRow); // 시작 전 연결 검증
          await adapter.getAccount();
        }
        await sb.from('bnf_trading_strategies').update({
          status: running ? 'RUNNING' : 'STOPPED', last_error: '', updated_at: new Date().toISOString(),
        }).eq('id', id).eq('user_id', uid);
        await log(sb, uid, 'info', running ? '전략 실행' : '전략 중지', `${strat.strategy_code} (id ${id})`);
        return json({ ok: true, status: running ? 'RUNNING' : 'STOPPED' });
      }

      case 'delete-strategy': {
        const id = Number(body.id);
        if (!id) return json({ ok: false, error: 'id 필요' }, 400);
        await sb.from('bnf_trading_strategies').delete().eq('id', id).eq('user_id', uid);
        await log(sb, uid, 'info', '전략 삭제', `id ${id}`);
        return json({ ok: true });
      }

      default:
        return json({ ok: false, error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log(sb, uid, 'error', `API 오류 (${action})`, msg);
    return json({ ok: false, error: msg }, 502);
  }
};
