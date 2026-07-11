import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { UNIVERSE_OPTIONS } from '../lib/marketData';
import StrategyPicker from '../components/StrategyPicker';

interface TradeSettings {
  broker: 'kis' | 'toss';
  mode: 'paper' | 'real';
  accountNo: string;
  accountProductCd: string;
  appKeyMasked?: string;
  appSecretSet?: boolean;
  enabled?: boolean;
  status?: string;
  strategyCode: string;
  universe: string;
  intervalMin: number;
  maxPositions: number;
  budgetPct: number;
  lastRunAt?: string | null;
  lastError?: string;
}
interface Account { totalAsset: number; cash: number; evalAmount: number; pnl: number; pnlPct: number; positionCount: number }
interface BrokerPos { symbol: string; name: string; qty: number; sellableQty: number; avgPrice: number; curPrice: number; evalAmount: number; pnl: number; pnlPct: number }
interface LiveTrade { id: number; symbol: string; name: string; strategy_code: string; side: string; trigger_note: string; order_type: string; order_price: number; qty: number; pnl: number; order_no: string; status: string; executed_at: string; mode: string }
interface TradeLog { id: number; level: string; event: string; detail: string; created_at: string }

const DEFAULT_SETTINGS: TradeSettings = {
  broker: 'kis', mode: 'paper', accountNo: '', accountProductCd: '01',
  strategyCode: 'bnf1', universe: 'KOSPI', intervalMin: 10, maxPositions: 5, budgetPct: 10,
};

const sideLabel: Record<string, { text: string; cls: string }> = {
  BUY: { text: '매수', cls: 'bg-up/20 text-up' },
  SELL_TP1: { text: '1차익절', cls: 'bg-profit/20 text-profit' },
  SELL_TP2: { text: '익절', cls: 'bg-profit/20 text-profit' },
  SELL_SL: { text: '손절/청산', cls: 'bg-amber-500/20 text-amber-400' },
  FORCE_SELL: { text: '강제매도', cls: 'bg-red-500/20 text-red-400' },
};

export default function TradingPage() {
  const { profile, guestMode } = useAuth();
  const [settings, setSettings] = useState<TradeSettings>(DEFAULT_SETTINGS);
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [encryption, setEncryption] = useState<boolean | null>(null);
  const [status, setStatus] = useState('STOPPED');
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [lastError, setLastError] = useState('');
  const [keyMasked, setKeyMasked] = useState('');
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<BrokerPos[]>([]);
  const [trades, setTrades] = useState<LiveTrade[]>([]);
  const [logs, setLogs] = useState<TradeLog[]>([]);
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
          strategyCode: s.strategyCode, universe: s.universe, intervalMin: s.intervalMin,
          maxPositions: s.maxPositions, budgetPct: Number(s.budgetPct),
        });
        setStatus(s.status ?? 'STOPPED');
        setLastRunAt(s.lastRunAt ?? null);
        setLastError(s.lastError ?? '');
        setKeyMasked(s.appKeyMasked ?? '');
      }
    } catch { /* 함수 미배포(로컬) 등 — 화면은 유지 */ }
  }, [api]);

  const loadHistory = useCallback(async () => {
    if (guestMode || !profile) return;
    const { data: t } = await supabase.from('bnf_live_trades').select('*').eq('user_id', profile.id).order('executed_at', { ascending: false }).limit(50);
    setTrades((t as unknown as LiveTrade[]) ?? []);
    const { data: l } = await supabase.from('bnf_trade_logs').select('*').eq('user_id', profile.id).order('created_at', { ascending: false }).limit(100);
    setLogs((l as unknown as TradeLog[]) ?? []);
  }, [guestMode, profile]);

  useEffect(() => { if (!guestMode) { loadSettings(); loadHistory(); } }, [guestMode, loadSettings, loadHistory]);

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
    await loadHistory();
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

  const downloadCsv = () => {
    const head = 'id,일시,모드,종목,구분,수량,주문가,손익,트리거,주문번호,상태\n';
    const rows = trades.map((t) =>
      [t.id, t.executed_at, t.mode, t.name || t.symbol, t.side, t.qty, t.order_price, t.pnl, `"${(t.trigger_note ?? '').replace(/"/g, '""')}"`, t.order_no, t.status].join(','),
    ).join('\n');
    const blob = new Blob(['﻿' + head + rows], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `auto_trades_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const fmt = (n: number) => Math.round(n).toLocaleString('ko-KR');

  if (guestMode) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-white">자동매매</h1>
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
          <h1 className="text-2xl font-bold text-white">자동매매 (실거래)</h1>
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
          <h2 className="font-bold text-white">🔌 증권사 연결 설정</h2>
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
          <h2 className="font-bold text-white">⚙️ 자동매매 규칙</h2>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">매매 전략</label>
              <StrategyPicker value={settings.strategyCode} onChange={(c) => setF('strategyCode', c)} className="input w-full" />
            </div>
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
              <label className="text-xs text-slate-400 block mb-1">최대 보유 종목 수</label>
              <input className="input w-full" type="number" min={1} max={20} value={settings.maxPositions} onChange={(e) => setF('maxPositions', Number(e.target.value))} />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">1회 매수 비중 (예수금 대비 %)</label>
              <input className="input w-full" type="number" min={1} max={100} value={settings.budgetPct} onChange={(e) => setF('budgetPct', Number(e.target.value))} />
            </div>
          </div>
          <p className="text-xs text-slate-500 leading-relaxed">
            장중(평일 09:00~15:30) 서버 스케줄러가 설정 주기마다: ① 보유 포지션의 전략 매도 트리거 검사 → 시장가 매도,
            ② 유니버스 매수 트리거 검사 → 예수금×비중만큼 시장가 매수. 체결 시 텔레그램으로 알립니다(설정 페이지 연동 필요).
          </p>
        </div>
      </div>

      {/* ── 계좌 현황 ── */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-white">💳 계좌 현황 (거래소 실시간)</h2>
          <button className="btn-ghost !py-1 !px-3 text-sm" onClick={refreshBroker} disabled={busy !== null}>
            {busy === 'refresh' ? '조회 중...' : '🔄 새로고침'}
          </button>
        </div>
        {account ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">총평가자산</div><div className="text-lg font-bold text-white">{fmt(account.totalAsset)}원</div></div>
            <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">예수금</div><div className="text-lg font-bold text-white">{fmt(account.cash)}원</div></div>
            <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">주식 평가금액</div><div className="text-lg font-bold text-white">{fmt(account.evalAmount)}원</div></div>
            <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">평가손익</div><div className={`text-lg font-bold ${account.pnl >= 0 ? 'text-up' : 'text-down'}`}>{fmt(account.pnl)}원 ({account.pnlPct.toFixed(2)}%)</div></div>
            <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">보유종목수</div><div className="text-lg font-bold text-white">{account.positionCount}종목</div></div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">[새로고침]을 눌러 거래소 계좌를 조회하세요. (설정 저장 + 연결 테스트 선행)</p>
        )}
      </div>

      {/* ── 보유 포지션 + 강제매도 ── */}
      <div className="card overflow-x-auto">
        <h2 className="font-bold text-white mb-2">📦 거래소 보유 포지션</h2>
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
                <td className="td font-medium text-white">{p.name} <span className="text-xs text-slate-500">{p.symbol}</span></td>
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

      {/* ── 자동매매 거래 이력 ── */}
      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-bold text-white">📜 자동매매 거래 이력 (최근 50건)</h2>
          <button className="btn-ghost !py-1 !px-3 text-sm" onClick={downloadCsv} disabled={trades.length === 0}>CSV 다운로드</button>
        </div>
        <table className="w-full whitespace-nowrap">
          <thead>
            <tr className="border-b border-edge">
              <th className="th">일시</th><th className="th">모드</th><th className="th">종목</th><th className="th">구분</th>
              <th className="th">수량</th><th className="th">주문가</th><th className="th">추정손익</th><th className="th">트리거</th><th className="th">상태</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 && <tr><td colSpan={9} className="td text-center text-slate-500 py-8">자동매매 거래 이력이 없습니다.</td></tr>}
            {trades.map((t) => (
              <tr key={t.id} className="border-b border-edge/50">
                <td className="td text-slate-400">{new Date(t.executed_at).toLocaleString('ko-KR')}</td>
                <td className="td"><span className={`badge ${t.mode === 'real' ? 'bg-red-500/20 text-red-400' : 'bg-edge text-slate-400'}`}>{t.mode === 'real' ? '실전' : '모의'}</span></td>
                <td className="td text-white">{t.name || t.symbol}</td>
                <td className="td"><span className={`badge ${sideLabel[t.side]?.cls ?? 'bg-edge text-slate-300'}`}>{sideLabel[t.side]?.text ?? t.side}</span></td>
                <td className="td">{t.qty}주</td>
                <td className="td">{fmt(Number(t.order_price))}</td>
                <td className={`td font-bold ${Number(t.pnl) > 0 ? 'text-up' : Number(t.pnl) < 0 ? 'text-down' : 'text-slate-400'}`}>{fmt(Number(t.pnl))}원</td>
                <td className="td text-slate-400 max-w-[280px] truncate" title={t.trigger_note}>{t.trigger_note}</td>
                <td className="td">{t.status === 'SUBMITTED' ? <span className="text-profit">접수</span> : <span className="text-red-400">실패</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── 자동매매 로그 ── */}
      <div className="card">
        <h2 className="font-bold text-white mb-2">🧾 자동매매 로그 (최근 100건)</h2>
        <div className="max-h-72 overflow-y-auto space-y-1 text-sm">
          {logs.length === 0 && <div className="text-slate-500 py-4 text-center">로그가 없습니다.</div>}
          {logs.map((l) => (
            <div key={l.id} className={`px-3 py-1.5 rounded flex gap-3 ${
              l.level === 'error' ? 'bg-red-500/10 text-red-300' : l.level === 'warn' ? 'bg-amber-500/10 text-amber-300' : 'bg-edge/40 text-slate-300'
            }`}>
              <span className="text-slate-500 shrink-0">{new Date(l.created_at).toLocaleString('ko-KR')}</span>
              <span className="font-semibold shrink-0">{l.event}</span>
              <span className="truncate" title={l.detail}>{l.detail}</span>
            </div>
          ))}
        </div>
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
