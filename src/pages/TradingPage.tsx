import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { UNIVERSE_OPTIONS } from '../lib/marketData';
import { ALL_STRATEGIES } from '../lib/strategies';

interface StrategyBudget {
  strategyCode: string;
  budget: number;
  enabled: boolean;
}

interface TradeSettings {
  broker: 'kis' | 'toss';
  mode: 'paper' | 'real';
  accountNo: string;
  accountProductCd: string;
  appKeyMasked?: string;
  appSecretSet?: boolean;
  enabled?: boolean;
  status?: string;
  universe: string;
  intervalMin: number;
  maxPositions: number;
  lastRunAt?: string | null;
  lastError?: string;
}
interface Account { totalAsset: number; cash: number; evalAmount: number; pnl: number; pnlPct: number; positionCount: number }
interface BrokerPos { symbol: string; name: string; qty: number; sellableQty: number; avgPrice: number; curPrice: number; evalAmount: number; pnl: number; pnlPct: number }

const DEFAULT_SETTINGS: TradeSettings = {
  broker: 'kis', mode: 'paper', accountNo: '', accountProductCd: '01',
  universe: 'KOSPI', intervalMin: 10, maxPositions: 5,
};

export default function TradingPage() {
  const { guestMode, allowedStrategyCodes } = useAuth();
  const [settings, setSettings] = useState<TradeSettings>(DEFAULT_SETTINGS);
  const allowedStrategies = ALL_STRATEGIES.filter((m) => allowedStrategyCodes.includes(m.code));
  const [strategies, setStrategies] = useState<StrategyBudget[]>(
    allowedStrategies.map((m) => ({ strategyCode: m.code, budget: 0, enabled: false })),
  );
  const setStratField = (code: string, patch: Partial<StrategyBudget>) =>
    setStrategies((prev) => prev.map((s) => (s.strategyCode === code ? { ...s, ...patch } : s)));
  const totalBudget = strategies.filter((s) => s.enabled).reduce((sum, s) => sum + (Number(s.budget) || 0), 0);
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [encryption, setEncryption] = useState<boolean | null>(null);
  const [status, setStatus] = useState('STOPPED');
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [lastError, setLastError] = useState('');
  const [keyMasked, setKeyMasked] = useState('');
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<BrokerPos[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const flash = (ok: boolean, text: string) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 4000); };
  const setF = <K extends keyof TradeSettings>(k: K, v: TradeSettings[K]) => setSettings((p) => ({ ...p, [k]: v }));

  const api = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('로그인이 필요합니다.');
    const res = await fetch('/api/broker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, accessToken: token, ...extra }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
    return j;
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const j = await api('get-settings');
      setEncryption(j.encryption ?? null);
      if (j.settings) {
        const s = j.settings;
        setSettings({
          broker: s.broker, mode: s.mode, accountNo: s.accountNo, accountProductCd: s.accountProductCd,
          universe: s.universe, intervalMin: s.intervalMin, maxPositions: s.maxPositions,
        });
        const saved = new Map<string, StrategyBudget>((s.strategies ?? []).map((st: StrategyBudget) => [st.strategyCode, st]));
        setStrategies(allowedStrategies.map((m) => saved.get(m.code) ?? { strategyCode: m.code, budget: 0, enabled: false }));
        setStatus(s.status ?? 'STOPPED');
        setLastRunAt(s.lastRunAt ?? null);
        setLastError(s.lastError ?? '');
        setKeyMasked(s.appKeyMasked ?? '');
      }
    } catch { /* 함수 미배포(로컬) 등 — 화면은 유지 */ }
  }, [api]);

  useEffect(() => { if (!guestMode) { loadSettings(); } }, [guestMode, loadSettings]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await fn(); } catch (e) { flash(false, e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const saveSettings = () => run('save', async () => {
    await api('save-settings', {
      settings: { ...settings, appKey: appKey.trim() || undefined, appSecret: appSecret.trim() || undefined },
      strategies,
    });
    setAppKey(''); setAppSecret('');
    flash(true, '설정을 저장했습니다.');
    await loadSettings();
  });

  const testConn = () => run('test', async () => {
    const j = await api('test');
    setAccount(j.account);
    flash(true, `연결 성공! 예수금 ${Math.round(j.account.cash).toLocaleString('ko-KR')}원`);
  });

  const refreshBroker = () => run('refresh', async () => {
    const [a, p] = await Promise.all([api('account'), api('positions')]);
    setAccount(a.account);
    setPositions(p.positions);
  });

  const toggle = (running: boolean) => run('toggle', async () => {
    if (running && settings.mode === 'real') {
      if (!confirm('⚠️ 실전투자 모드입니다. 실제 계좌에서 실제 주문이 실행됩니다.\n자동매매를 시작할까요?')) return;
    }
    const j = await api('toggle', { running });
    setStatus(j.status);
    flash(true, running ? '자동매매를 시작했습니다. 장중 설정 주기마다 서버에서 자동 실행됩니다.' : '자동매매를 중지했습니다.');
  });

  const forceSell = (p: BrokerPos) => run('sell-' + p.symbol, async () => {
    const input = prompt(`${p.name} 강제매도 수량 (보유 ${p.sellableQty}주, 전량은 그대로 확인)`, String(p.sellableQty));
    if (input == null) return;
    const qty = Math.floor(Number(input));
    if (!qty || qty < 1 || qty > p.sellableQty) { flash(false, '수량이 올바르지 않습니다.'); return; }
    if (!confirm(`${p.name} ${qty}주를 시장가로 즉시 매도합니다. 진행할까요?`)) return;
    const j = await api('force-sell', { symbol: p.symbol, name: p.name, qty, price: 0 });
    flash(true, `강제매도 접수 (주문번호 ${j.orderNo})`);
    await refreshBroker();
  });

  const fmt = (n: number) => Math.round(n).toLocaleString('ko-KR');

  if (guestMode) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-ink">자동매매</h1>
        <div className="card text-sm text-amber-300 bg-amber-500/10 border-amber-500/40">
          자동매매는 로그인(Supabase 설정) 상태에서만 사용할 수 있습니다. 게스트 데모 모드에서는 모의투자(시뮬레이션)를 이용하세요.
        </div>
      </div>
    );
  }

  const statusBadge =
    status === 'RUNNING' ? <span className="badge bg-profit/20 text-profit">● 실행 중</span>
    : status === 'ERROR' ? <span className="badge bg-red-500/20 text-red-400">● 오류</span>
    : <span className="badge bg-edge text-slate-400">● 중지됨</span>;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">자동매매 (실거래)</h1>
          <p className="text-sm text-slate-400 mt-1">
            전략 트리거로만 주문하는 무인 자동매매 — 브라우저를 꺼도 장중 {settings.intervalMin}분 주기로 서버에서 실행됩니다. AI 미사용.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {statusBadge}
          {status === 'RUNNING' ? (
            <button className="btn-danger" onClick={() => toggle(false)} disabled={busy !== null}>
              {busy === 'toggle' ? '처리 중...' : '⏸ 자동매매 중지'}
            </button>
          ) : (
            <button className="btn-primary" onClick={() => toggle(true)} disabled={busy !== null}>
              {busy === 'toggle' ? '처리 중...' : '▶ 자동매매 시작'}
            </button>
          )}
        </div>
      </header>

      {msg && <div className={`text-sm rounded-lg p-3 ${msg.ok ? 'bg-profit/10 text-profit' : 'bg-red-500/10 text-red-400'}`}>{msg.text}</div>}
      {lastError && status === 'ERROR' && (
        <div className="card bg-red-500/10 border-red-500/40 text-red-300 text-sm">최근 오류: {lastError}</div>
      )}
      {lastRunAt && <div className="text-xs text-slate-500">마지막 자동 실행: {new Date(lastRunAt).toLocaleString('ko-KR')}</div>}

      <div className="grid xl:grid-cols-2 gap-4 items-start">
        {/* ── 브로커 설정 ── */}
        <div className="card space-y-3">
          <h2 className="font-bold text-ink">🔌 증권사 연결 설정</h2>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">증권사</label>
              <select className="input w-full" value={settings.broker} onChange={(e) => setF('broker', e.target.value as 'kis' | 'toss')}>
                <option value="kis">한국투자증권 (KIS Open API)</option>
                <option value="toss">토스증권 (공개 API 미제공 — 준비됨)</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">투자 모드</label>
              <select className="input w-full" value={settings.mode} onChange={(e) => setF('mode', e.target.value as 'paper' | 'real')}>
                <option value="paper">모의투자 (KIS 모의계좌)</option>
                <option value="real">⚠️ 실전투자 (실제 주문)</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">App Key {keyMasked && <span className="text-slate-500">(저장됨: {keyMasked})</span>}</label>
              <input className="input w-full" type="password" value={appKey} onChange={(e) => setAppKey(e.target.value)} placeholder={keyMasked ? '변경 시에만 입력' : 'KIS 개발자센터에서 발급'} />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">App Secret</label>
              <input className="input w-full" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={keyMasked ? '변경 시에만 입력' : 'App Secret'} />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">계좌번호 (앞 8자리)</label>
              <input className="input w-full" value={settings.accountNo} onChange={(e) => setF('accountNo', e.target.value)} placeholder="12345678" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">계좌상품코드 (뒤 2자리)</label>
              <input className="input w-full" value={settings.accountProductCd} onChange={(e) => setF('accountProductCd', e.target.value)} placeholder="01" />
            </div>
          </div>
          {encryption === false && (
            <p className="text-xs text-amber-400">⚠️ 서버에 BROKER_ENC_KEY 환경변수가 없어 API 키가 암호화되지 않습니다. Netlify에 BROKER_ENC_KEY(임의의 긴 문자열)를 추가하는 것을 권장합니다.</p>
          )}
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={testConn} disabled={busy !== null}>{busy === 'test' ? '테스트 중...' : '연결 테스트'}</button>
            <button className="btn-primary" onClick={saveSettings} disabled={busy !== null}>{busy === 'save' ? '저장 중...' : '저장'}</button>
          </div>
        </div>

        {/* ── 자동매매 전략 설정 ── */}
        <div className="card space-y-3">
          <h2 className="font-bold text-ink">⚙️ 자동매매 규칙</h2>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">매수 스캔 대상</label>
              <select className="input w-full" value={settings.universe} onChange={(e) => setF('universe', e.target.value)}>
                {UNIVERSE_OPTIONS.filter((u) => u.key !== 'WATCH').map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">실행 주기 (분, 최소 10)</label>
              <input className="input w-full" type="number" min={10} step={5} value={settings.intervalMin} onChange={(e) => setF('intervalMin', Math.max(10, Number(e.target.value)))} />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">최대 보유 종목 수 (전체 전략 합산)</label>
              <input className="input w-full" type="number" min={1} max={20} value={settings.maxPositions} onChange={(e) => setF('maxPositions', Number(e.target.value))} />
            </div>
          </div>

          <div>
            <label className="text-xs text-slate-400 block mb-1">전략별 자동매매 예산 (2개 이상 동시 실행 가능)</label>
            <div className="space-y-2">
              {strategies.map((s) => {
                const mod = allowedStrategies.find((m) => m.code === s.strategyCode);
                if (!mod) return null;
                return (
                  <div key={s.strategyCode} className="flex items-center gap-2 bg-base rounded-lg p-2">
                    <input
                      type="checkbox" checked={s.enabled}
                      onChange={(e) => setStratField(s.strategyCode, { enabled: e.target.checked })}
                    />
                    <span className="text-sm text-ink flex-1 truncate" title={mod.name}>{mod.name}</span>
                    <input
                      className="input !w-32 text-right" type="number" min={0} step={10000}
                      value={s.budget} disabled={!s.enabled}
                      onChange={(e) => setStratField(s.strategyCode, { budget: Math.max(0, Number(e.target.value)) })}
                      placeholder="예산(원)"
                    />
                    <span className="text-xs text-slate-500 w-4">원</span>
                  </div>
                );
              })}
              {strategies.length === 0 && <p className="text-sm text-slate-500">사용 가능한 전략이 없습니다. 관리자에게 전략 권한을 요청하세요.</p>}
            </div>
            <p className="text-xs text-slate-400 mt-2">총 배정 예산: <span className="text-ink font-semibold">{fmt(totalBudget)}원</span></p>
          </div>

          <p className="text-xs text-slate-500 leading-relaxed">
            장중(평일 09:00~15:30) 서버 스케줄러가 설정 주기마다: ① 보유 포지션의 전략 매도 트리거 검사 → 시장가 매도,
            ② 전략별로 유니버스 매수 트리거 검사 → 전략 예산(보유 중인 금액 차감한 잔여분)을 매수신호 종목들의 점수(추천도) 비중으로 배분해 시장가 매수.
            체결 시 텔레그램으로 알립니다(설정 페이지 연동 필요).
          </p>
        </div>
      </div>

      {/* ── 계좌 현황 ── */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-ink">💳 계좌 현황 (거래소 실시간)</h2>
          <button className="btn-ghost !py-1 !px-3 text-sm" onClick={refreshBroker} disabled={busy !== null}>
            {busy === 'refresh' ? '조회 중...' : '🔄 새로고침'}
          </button>
        </div>
        {account ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">총평가자산</div><div className="text-lg font-bold text-ink">{fmt(account.totalAsset)}원</div></div>
            <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">예수금</div><div className="text-lg font-bold text-ink">{fmt(account.cash)}원</div></div>
            <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">주식 평가금액</div><div className="text-lg font-bold text-ink">{fmt(account.evalAmount)}원</div></div>
            <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">평가손익</div><div className={`text-lg font-bold ${account.pnl >= 0 ? 'text-up' : 'text-down'}`}>{fmt(account.pnl)}원 ({account.pnlPct.toFixed(2)}%)</div></div>
            <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">보유종목수</div><div className="text-lg font-bold text-ink">{account.positionCount}종목</div></div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">[새로고침]을 눌러 거래소 계좌를 조회하세요. (설정 저장 + 연결 테스트 선행)</p>
        )}
      </div>

      {/* ── 보유 포지션 + 강제매도 ── */}
      <div className="card overflow-x-auto">
        <h2 className="font-bold text-ink mb-2">📦 거래소 보유 포지션</h2>
        <table className="w-full whitespace-nowrap">
          <thead>
            <tr className="border-b border-edge">
              <th className="th">종목</th><th className="th">수량</th><th className="th">평균단가</th><th className="th">현재가</th>
              <th className="th">평가금액</th><th className="th">평가손익</th><th className="th">수익률</th><th className="th">액션</th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 && <tr><td colSpan={8} className="td text-center text-slate-500 py-8">보유 포지션이 없거나 아직 조회하지 않았습니다.</td></tr>}
            {positions.map((p) => (
              <tr key={p.symbol} className="border-b border-edge/50">
                <td className="td font-medium text-ink">{p.name} <span className="text-xs text-slate-500">{p.symbol}</span></td>
                <td className="td">{p.qty}주</td>
                <td className="td">{fmt(p.avgPrice)}</td>
                <td className="td">{fmt(p.curPrice)}</td>
                <td className="td">{fmt(p.evalAmount)}</td>
                <td className={`td font-bold ${p.pnl >= 0 ? 'text-up' : 'text-down'}`}>{fmt(p.pnl)}원</td>
                <td className={`td ${p.pnlPct >= 0 ? 'text-up' : 'text-down'}`}>{p.pnlPct.toFixed(2)}%</td>
                <td className="td">
                  <button className="text-red-400 hover:underline text-sm" onClick={() => forceSell(p)} disabled={busy !== null}>
                    {busy === 'sell-' + p.symbol ? '접수 중...' : '⚡ 강제매도'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── 거래이력·로그 바로가기 ── */}
      <Link to="/trading/history" className="card flex items-center justify-between hover:border-accent transition-colors">
        <div>
          <h2 className="font-bold text-ink">📜 거래이력 · 로그</h2>
          <p className="text-sm text-slate-400 mt-1">자동매매 대시보드 · 거래 이력 · 실행 로그를 기간별로 조회합니다.</p>
        </div>
        <span className="text-accent">보러가기 →</span>
      </Link>

      <div className="card text-xs text-slate-500 leading-relaxed">
        <div className="font-bold text-slate-400 mb-1">유의사항</div>
        · 한국투자증권 API 키는 <a className="text-accent" href="https://apiportal.koreainvestment.com" target="_blank" rel="noreferrer">KIS Developers</a>에서 발급받으세요 (모의투자 키로 먼저 검증 권장).<br />
        · 토스증권은 현재 개인용 공개 매매 API를 제공하지 않아 어댑터만 준비되어 있습니다.<br />
        · 자동매매는 전략 트리거만으로 주문하며(AI 미사용), 모든 주문은 거래 이력과 로그에 기록됩니다.<br />
        · 실전투자 모드는 실제 자금 손실이 발생할 수 있습니다. 투자 판단의 책임은 사용자 본인에게 있습니다.
      </div>
    </div>
  );
}
