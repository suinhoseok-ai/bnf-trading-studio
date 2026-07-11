// ===== 자동매매 브로커 API (인증된 사용자 전용 HTTP 함수) =====
// POST /api/broker  { action, accessToken, ... }
// actions:
//   save-settings  설정 저장 (API 키는 AES-GCM 암호화)
//   get-settings   설정 조회 (키는 마스킹)
//   test           브로커 연결 테스트 (토큰 발급 + 계좌 조회)
//   account        계좌 요약
//   positions      거래소 보유 포지션
//   orders         최근 주문 내역
//   force-sell     강제매도 { symbol, qty(0=전량), price(0=시장가) }
//   toggle         자동매매 시작/중지 { running }
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
          strategy_code: String(s.strategyCode ?? 'bnf1'),
          universe: String(s.universe ?? 'KOSPI'),
          interval_min: Math.max(10, Number(s.intervalMin) || 10),
          max_positions: Math.min(20, Math.max(1, Number(s.maxPositions) || 5)),
          budget_pct: Math.min(100, Math.max(1, Number(s.budgetPct) || 10)),
          updated_at: new Date().toISOString(),
        };
        // 키는 새 값이 입력된 경우에만 갱신 (빈 값이면 기존 유지)
        if (s.appKey) row.app_key = encryptSecret(String(s.appKey).trim());
        if (s.appSecret) row.app_secret = encryptSecret(String(s.appSecret).trim());
        // 브로커/모드가 바뀌면 토큰 캐시 무효화
        if (existing && (existing.broker !== row.broker || existing.mode !== row.mode)) row.token = {};
        const { error } = await sb.from('bnf_trading_settings').upsert(row);
        if (error) return json({ ok: false, error: error.message }, 500);
        await log(sb, uid, 'info', '설정 저장', `${row.broker}/${row.mode} 전략=${row.strategy_code}`);
        return json({ ok: true, encryption: encryptionEnabled() });
      }

      case 'get-settings': {
        const row = await loadSettings();
        if (!row) return json({ ok: true, settings: null, encryption: encryptionEnabled() });
        return json({
          ok: true,
          encryption: encryptionEnabled(),
          settings: {
            broker: row.broker, mode: row.mode,
            accountNo: row.account_no, accountProductCd: row.account_product_cd,
            appKeyMasked: maskKey(row.app_key), appSecretSet: !!row.app_secret,
            enabled: row.enabled, status: row.status,
            strategyCode: row.strategy_code, universe: row.universe,
            intervalMin: row.interval_min, maxPositions: row.max_positions, budgetPct: row.budget_pct,
            lastRunAt: row.last_run_at, lastError: row.last_error,
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

      case 'toggle': {
        const running = !!body.running;
        const row = await loadSettings();
        if (!row) return json({ ok: false, error: '설정을 먼저 저장하세요.' }, 400);
        if (running) {
          // 시작 전 연결 검증
          const adapter = await makeAdapter(sb, row);
          await adapter.getAccount();
        }
        await sb.from('bnf_trading_settings').update({
          enabled: running, status: running ? 'RUNNING' : 'STOPPED', last_error: '', updated_at: new Date().toISOString(),
        }).eq('user_id', uid);
        await log(sb, uid, 'info', running ? '자동매매 시작' : '자동매매 중지', `${row.broker}/${row.mode} 전략=${row.strategy_code}`);
        return json({ ok: true, status: running ? 'RUNNING' : 'STOPPED' });
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
