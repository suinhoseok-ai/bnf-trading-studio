import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { UNIVERSE_OPTIONS } from '../lib/marketData';
import { ALL_STRATEGIES } from '../lib/strategies';

interface StrategyCard {
  id: number | null;       // 서버 저장 전이면 null
  strategyCode: string;
  universe: string;
  intervalMin: number;
  maxPositions: number;
  budget: number;
  status: string;          // RUNNING | STOPPED | ERROR (미저장 카드는 항상 STOPPED)
  lastRunAt: string | null;
  lastError: string;
  regimeFilterEnabled: boolean;
}

interface RiskGuard {
  dailyLossEnabled: boolean; dailyLossPct: number;
  circuitEnabled: boolean; circuitDropPct: number; circuitBlockHours: number; circuitUntil: string | null;
  streakEnabled: boolean; streakLosses: number; streakBlockHours: number;
  symbolCooldownEnabled: boolean; symbolCooldownHours: number;
  bearMajorLiquidate: boolean;
}
const DEFAULT_RISKGUARD: RiskGuard = {
  dailyLossEnabled: false, dailyLossPct: 3,
  circuitEnabled: true, circuitDropPct: 5, circuitBlockHours: 12, circuitUntil: null,
  streakEnabled: false, streakLosses: 3, streakBlockHours: 24,
  symbolCooldownEnabled: true, symbolCooldownHours: 24,
  bearMajorLiquidate: false,
};

interface TradeSettings {
  broker: 'kis' | 'toss';
  mode: 'paper' | 'real';
  accountNo: string;
  accountProductCd: string;
  appKeyMasked?: string;
  appSecretSet?: boolean;
}
interface Account { totalAsset: number; cash: number; evalAmount: number; pnl: number; pnlPct: number; positionCount: number }
interface BrokerPos { symbol: string; name: string; qty: number; sellableQty: number; avgPrice: number; curPrice: number; evalAmount: number; pnl: number; pnlPct: number }

const DEFAULT_SETTINGS: TradeSettings = {
  broker: 'kis', mode: 'paper', accountNo: '', accountProductCd: '01',
};

const newCard = (strategyCode: string): StrategyCard => ({
  id: null, strategyCode, universe: 'KOSPI', intervalMin: 10, maxPositions: 5, budget: 0,
  status: 'STOPPED', lastRunAt: null, lastError: '', regimeFilterEnabled: true,
});

export default function TradingPage() {
  const { guestMode, allowedStrategyCodes } = useAuth();
  const [settings, setSettings] = useState<TradeSettings>(DEFAULT_SETTINGS);
  const allowedStrategies = ALL_STRATEGIES.filter((m) => allowedStrategyCodes.includes(m.code));
  const [strategies, setStrategies] = useState<StrategyCard[]>([]);
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [encryption, setEncryption] = useState<boolean | null>(null);
  const [keyMasked, setKeyMasked] = useState('');
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<BrokerPos[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [riskGuard, setRiskGuard] = useState<RiskGuard>(DEFAULT_RISKGUARD);

  const flash = (ok: boolean, text: string) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 4000); };
  const setF = <K extends keyof TradeSettings>(k: K, v: TradeSettings[K]) => setSettings((p) => ({ ...p, [k]: v }));
  const setCard = (idx: number, patch: Partial<StrategyCard>) =>
    setStrategies((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  const setRg = <K extends keyof RiskGuard>(k: K, v: RiskGuard[K]) => setRiskGuard((p) => ({ ...p, [k]: v }));

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
        setSettings({ broker: s.broker, mode: s.mode, accountNo: s.accountNo, accountProductCd: s.accountProductCd });
        setKeyMasked(s.appKeyMasked ?? '');
        setStrategies((s.strategies ?? []).map((st: {
          id: number; strategyCode: string; universe: string; intervalMin: number; maxPositions: number;
          budget: number; status: string; lastRunAt: string | null; lastError: string; regimeFilterEnabled: boolean;
        }) => ({
          id: st.id, strategyCode: st.strategyCode, universe: st.universe,
          intervalMin: st.intervalMin, maxPositions: st.maxPositions, budget: st.budget,
          status: st.status, lastRunAt: st.lastRunAt, lastError: st.lastError,
          regimeFilterEnabled: st.regimeFilterEnabled !== false,
        })));
        if (s.riskGuard) setRiskGuard({ ...DEFAULT_RISKGUARD, ...s.riskGuard });
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
    await api('save-settings', { settings: { ...settings, appKey: appKey.trim() || undefined, appSecret: appSecret.trim() || undefined } });
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

  const addStrategy = () => {
    const used = new Set(strategies.map((s) => s.strategyCode));
    const code = allowedStrategies.find((m) => !used.has(m.code))?.code ?? allowedStrategies[0]?.code;
    if (!code) { flash(false, '사용 가능한 전략이 없습니다.'); return; }
    setStrategies((prev) => [...prev, newCard(code)]);
  };

  const saveCard = (idx: number) => run(`save-${idx}`, async () => {
    const c = strategies[idx];
    const j = await api('save-strategy', {
      strategy: {
        id: c.id ?? undefined, strategyCode: c.strategyCode, universe: c.universe, intervalMin: c.intervalMin,
        maxPositions: c.maxPositions, budget: c.budget, regimeFilterEnabled: c.regimeFilterEnabled,
      },
    });
    setCard(idx, { id: j.id });
    flash(true, '전략을 저장했습니다.');
  });

  const saveRiskGuard = () => run('riskguard', async () => {
    await api('save-riskguard', { riskGuard });
    flash(true, '리스크 가드 설정을 저장했습니다.');
    await loadSettings();
  });

  const toggleCard = (idx: number) => run(`toggle-${idx}`, async () => {
    const c = strategies[idx];
    if (!c.id) { flash(false, '먼저 [저장]을 눌러 전략을 저장하세요.'); return; }
    const running = c.status !== 'RUNNING';
    if (running && settings.mode === 'real') {
      if (!confirm('⚠️ 실전투자 모드입니다. 실제 계좌에서 실제 주문이 실행됩니다.\n이 전략을 실행할까요?')) return;
    }
    const j = await api('toggle-strategy', { id: c.id, running });
    setCard(idx, { status: j.status, lastError: '' });
    flash(true, running ? '전략을 실행했습니다.' : '전략을 중지했습니다.');
  });

  const deleteCard = (idx: number) => run(`delete-${idx}`, async () => {
    const c = strategies[idx];
    if (!confirm('이 전략 카드를 삭제할까요? (보유 중인 포지션은 계속 관리됩니다)')) return;
    if (c.id) await api('delete-strategy', { id: c.id });
    setStrategies((prev) => prev.filter((_, i) => i !== idx));
    flash(true, '전략을 삭제했습니다.');
  });

  const fmt = (n: number) => Math.round(n).toLocaleString('ko-KR');
  const totalBudget = strategies.reduce((sum, s) => sum + (Number(s.budget) || 0), 0);

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

  const cardStatusBadge = (status: string) =>
    status === 'RUNNING' ? <span className="badge bg-profit/20 text-profit">● 실행 중</span>
    : status === 'ERROR' ? <span className="badge bg-red-500/20 text-red-400">● 오류</span>
    : <span className="badge bg-edge text-slate-400">● 중지됨</span>;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">자동매매 (실거래)</h1>
          <p className="text-sm text-slate-400 mt-1">
            전략 트리거로만 주문하는 무인 자동매매 — 브라우저를 꺼도 24시간 서버에서 실행됩니다. AI 미사용. 여러 전략을 동시에 켜서 예산을 나눠 운용할 수 있습니다.
          </p>
        </div>
        <Link to="/trading/history" className="btn-ghost !py-1 !px-3 text-sm">📖 거래이력·로그 →</Link>
      </header>

      {msg && <div className={`text-sm rounded-lg p-3 ${msg.ok ? 'bg-profit/10 text-profit' : 'bg-red-500/10 text-red-400'}`}>{msg.text}</div>}

      {/* ── 거래소 연결 설정 ── */}
      <div className="card space-y-3">
        <h2 className="font-bold text-ink">🔌 거래소 연결 설정 (계정당 1개)</h2>
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
            <label className="text-xs text-slate-400 block mb-1">Secret Key</label>
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

      {/* ── 리스크 가드 (자동매매 안전장치) ── */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-ink">🛡 리스크 가드 (자동매매 안전장치)</h2>
          <button className="btn-primary !py-1 !px-3 text-sm" onClick={saveRiskGuard} disabled={busy !== null}>
            {busy === 'riskguard' ? '저장 중...' : '저장'}
          </button>
        </div>
        <p className="text-xs text-slate-500 leading-relaxed">
          각 항목을 개별로 켜고 끌 수 있습니다. <b className="text-slate-300">매도(청산)는 이 설정과 무관하게 항상 정상 동작</b>하며, 아래 조건은 "신규 매수만" 막습니다.
        </p>
        <div className="grid md:grid-cols-2 gap-3">
          <div className="rounded-xl border border-edge p-3 space-y-2">
            <label className="flex items-center gap-2 font-medium text-ink text-sm">
              <input type="checkbox" checked={riskGuard.dailyLossEnabled} onChange={(e) => setRg('dailyLossEnabled', e.target.checked)} />
              ① 일일 손실 한도
            </label>
            <p className="text-xs text-slate-500">당일 실현손실이 전체 예산의 일정 비율을 넘으면 오늘 신규 매수를 중지합니다.</p>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-400">한도</span>
              <input className="input w-24" type="number" min={0.1} max={50} step={0.5} value={riskGuard.dailyLossPct} onChange={(e) => setRg('dailyLossPct', Number(e.target.value))} />
              <span className="text-slate-400">% (전략 예산 합계 기준)</span>
            </div>
          </div>
          <div className="rounded-xl border border-edge p-3 space-y-2">
            <label className="flex items-center gap-2 font-medium text-ink text-sm">
              <input type="checkbox" checked={riskGuard.circuitEnabled} onChange={(e) => setRg('circuitEnabled', e.target.checked)} />
              ② 서킷브레이커 (급락 감지)
            </label>
            <p className="text-xs text-slate-500">KOSPI가 당일 기준 급락하면 일정 시간 전체(모든 전략) 신규 매수를 차단합니다.</p>
            <div className="flex items-center gap-2 text-sm flex-wrap">
              <span className="text-slate-400">급락폭</span>
              <input className="input w-20" type="number" min={0.5} max={30} step={0.5} value={riskGuard.circuitDropPct} onChange={(e) => setRg('circuitDropPct', Number(e.target.value))} />
              <span className="text-slate-400">% 이상 · 차단</span>
              <input className="input w-20" type="number" min={1} max={72} step={1} value={riskGuard.circuitBlockHours} onChange={(e) => setRg('circuitBlockHours', Number(e.target.value))} />
              <span className="text-slate-400">시간</span>
            </div>
            {riskGuard.circuitUntil && new Date(riskGuard.circuitUntil).getTime() > Date.now() && (
              <p className="text-xs text-red-400">⛔ 발동 중 — {new Date(riskGuard.circuitUntil).toLocaleString('ko-KR')}까지 차단</p>
            )}
          </div>
          <div className="rounded-xl border border-edge p-3 space-y-2">
            <label className="flex items-center gap-2 font-medium text-ink text-sm">
              <input type="checkbox" checked={riskGuard.streakEnabled} onChange={(e) => setRg('streakEnabled', e.target.checked)} />
              ③ 연속 손절 쿨다운
            </label>
            <p className="text-xs text-slate-500">같은 전략에서 연속 손절이 나면 그 전략의 매수를 일정 시간 쉽니다.</p>
            <div className="flex items-center gap-2 text-sm flex-wrap">
              <span className="text-slate-400">연속</span>
              <input className="input w-16" type="number" min={2} max={10} step={1} value={riskGuard.streakLosses} onChange={(e) => setRg('streakLosses', Number(e.target.value))} />
              <span className="text-slate-400">회 손절 시 · 정지</span>
              <input className="input w-20" type="number" min={1} max={168} step={1} value={riskGuard.streakBlockHours} onChange={(e) => setRg('streakBlockHours', Number(e.target.value))} />
              <span className="text-slate-400">시간</span>
            </div>
          </div>
          <div className="rounded-xl border border-edge p-3 space-y-2">
            <label className="flex items-center gap-2 font-medium text-ink text-sm">
              <input type="checkbox" checked={riskGuard.symbolCooldownEnabled} onChange={(e) => setRg('symbolCooldownEnabled', e.target.checked)} />
              ④ 동일 종목 재진입 쿨다운
            </label>
            <p className="text-xs text-slate-500">손절된 종목은 일정 시간 동안 어느 전략도 다시 매수하지 않습니다.</p>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-400">쿨다운</span>
              <input className="input w-20" type="number" min={1} max={168} step={1} value={riskGuard.symbolCooldownHours} onChange={(e) => setRg('symbolCooldownHours', Number(e.target.value))} />
              <span className="text-slate-400">시간</span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-3 space-y-1.5">
          <label className="flex items-center gap-2 font-medium text-red-300 text-sm">
            <input type="checkbox" checked={riskGuard.bearMajorLiquidate} onChange={(e) => setRg('bearMajorLiquidate', e.target.checked)} />
            ⚠️ 대세하락장(BEAR_MAJOR) 자동 전량청산 — 기본 OFF
          </label>
          <p className="text-xs text-slate-400 leading-relaxed">
            위 4가지는 "신규 매수만" 막지만, 이 옵션을 켜면 시장국면이 대세하락장으로 확정되는 즉시 자동매매가 보유 중인 모든 포지션을 시장가로 즉시 매도합니다. 수동으로 보유한 종목은 건드리지 않습니다.
            각 전략의 "장세 자동필터"가 꺼져있으면 그 전략의 포지션은 이 자동청산 대상에서 제외됩니다.
          </p>
          <p className="text-xs text-slate-500">※ 시장국면은 매일 장전(08:30)에 5단계(대세상승/상승/횡보/하락/대세하락)로 확정됩니다. 대세하락장 자동청산은 대세하락장으로 새로 확정된 그 날 1회만 실행되며, 그 뒤 국면이 유지되어도 다시 청산하지 않습니다.</p>
        </div>
      </div>

      {/* ── 자동매매 전략 (카드형, 여러 개 동시 운용) ── */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-bold text-ink">⚙️ 자동매매 전략 (여러 개 동시 운용 가능)</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400">예산 합계: <span className="text-ink font-semibold">{fmt(totalBudget)}원</span></span>
            <button className="btn-primary !py-1 !px-3 text-sm" onClick={addStrategy}>+ 전략 추가</button>
          </div>
        </div>
        <p className="text-xs text-slate-500 leading-relaxed">
          예산(원)은 각 전략에 고정 배정된 금액입니다(예: 전략A 10만원 + 전략B 20만원 = 항상 최대 30만원까지만 동시 사용). 한 사이클에 여러 종목이 동시에 매수 신호를 내면, 이 예산은 점수(추천도)가 높은 종목일수록 더 많이 배분해서 나눠 삽니다.
          보유 중인 포지션을 매도하면 그만큼 예산이 자동으로 재확보되어 다음 매수에 쓰입니다. 같은 종목을 두 전략이 동시에 사지는 않습니다. 24시간 서버가 전략별 실행주기마다: ① 보유 포지션 매도 트리거 검사 → 시장가 매도, ② 전략 유니버스 매수 트리거 검사 → 배정 예산 내에서 시장가 매수. 체결 시 텔레그램으로 알립니다(설정 페이지 연동 필요).
        </p>

        {strategies.length === 0 && (
          <p className="text-sm text-slate-500">등록된 전략이 없습니다. [+ 전략 추가]로 시작하세요.</p>
        )}

        {strategies.map((c, idx) => {
          const usedByOthers = new Set(strategies.filter((_, i) => i !== idx).map((s) => s.strategyCode));
          const options = allowedStrategies.filter((m) => m.code === c.strategyCode || !usedByOthers.has(m.code));
          return (
            <div key={idx} className="rounded-xl border border-edge p-4 space-y-3 bg-base">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-ink">전략{idx + 1}</span>
                  {cardStatusBadge(c.status)}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className={c.status === 'RUNNING' ? 'btn-danger !py-1 !px-3 text-sm' : 'btn-primary !py-1 !px-3 text-sm'}
                    onClick={() => toggleCard(idx)} disabled={busy !== null}
                  >
                    {busy === `toggle-${idx}` ? '처리 중...' : c.status === 'RUNNING' ? '⏸ 중지' : '▶ 실행'}
                  </button>
                  <button className="btn-ghost !py-1 !px-3 text-sm" onClick={() => saveCard(idx)} disabled={busy !== null}>
                    {busy === `save-${idx}` ? '저장 중...' : '저장'}
                  </button>
                  <button className="text-red-400 hover:underline text-sm" onClick={() => deleteCard(idx)} disabled={busy !== null}>
                    {busy === `delete-${idx}` ? '삭제 중...' : '삭제'}
                  </button>
                </div>
              </div>
              {c.lastRunAt && <div className="text-xs text-slate-500">마지막 실행: {new Date(c.lastRunAt).toLocaleString('ko-KR')}</div>}
              {c.lastError && c.status === 'ERROR' && <div className="text-xs text-red-400">최근 오류: {c.lastError}</div>}

              <div className="grid md:grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1">매매 전략</label>
                  <select className="input w-full" value={c.strategyCode} onChange={(e) => setCard(idx, { strategyCode: e.target.value })}>
                    {options.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">매수 스캔 대상</label>
                  <select className="input w-full" value={c.universe} onChange={(e) => setCard(idx, { universe: e.target.value })}>
                    {UNIVERSE_OPTIONS.filter((u) => u.key !== 'WATCH').map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">실행 주기 (분, 최소 10)</label>
                  <input className="input w-full" type="number" min={10} step={5} value={c.intervalMin} onChange={(e) => setCard(idx, { intervalMin: Math.max(10, Number(e.target.value)) })} />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">최대 보유 종목 수</label>
                  <input className="input w-full" type="number" min={1} max={20} value={c.maxPositions} onChange={(e) => setCard(idx, { maxPositions: Number(e.target.value) })} />
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1">예산 (고정 금액, 원)</label>
                  <div className="flex items-center gap-3">
                    <input className="input flex-1" type="number" min={0} step={10000} value={c.budget} onChange={(e) => setCard(idx, { budget: Math.max(0, Number(e.target.value)) })} />
                    <label className="flex items-center gap-1.5 text-xs text-slate-400 whitespace-nowrap shrink-0" title="장세 자동필터를 켜면(기본값) 시장국면이 전환/불확실 또는 대세하락장일 때 이 전략의 신규 매수만 자동으로 쉽니다. 꺼두면 국면과 무관하게 항상 기존처럼 동작합니다.">
                      <input type="checkbox" checked={c.regimeFilterEnabled} onChange={(e) => setCard(idx, { regimeFilterEnabled: e.target.checked })} />
                      🧭 장세 자동필터
                    </label>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
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
              <th className="th">종목</th><th className="th">수량</th><th className="th">평균매수가</th><th className="th">현재가</th>
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
