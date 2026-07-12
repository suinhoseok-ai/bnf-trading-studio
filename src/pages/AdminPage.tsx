import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { Profile, Strategy, AdminConfig } from '../lib/types';
import StrategyPicker from '../components/StrategyPicker';

type Tab = 'users' | 'strategies' | 'access' | 'report';

const DEFAULT_REPORT: AdminConfig = {
  reportEnabled: false,
  reportDays: [1, 2, 3, 4, 5],
  reportHour: 17,
  reportStrategy: 'bnf1',
  reportMarket: 'ALL',
  reportMaxStocks: 60,
  reportSortBy: 'score',
  reportTopN: 20,
  reportRecipient: '',
  fullReportEnabled: false,
  fullReportDays: [1, 2, 3, 4, 5],
  fullReportHour: 17,
  fullReportRecipient: '',
};
const DAY_LABELS: [number, string][] = [[1, '월'], [2, '화'], [3, '수'], [4, '목'], [5, '금'], [6, '토'], [0, '일']];

export default function AdminPage() {
  const { profile: me, guestMode, refreshProfile } = useAuth();
  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<Profile[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [accessUser, setAccessUser] = useState<string>('');
  const [accessMap, setAccessMap] = useState<Map<number, boolean>>(new Map());
  const [msg, setMsg] = useState('');
  const [report, setReport] = useState<AdminConfig>(DEFAULT_REPORT);
  const [savingReport, setSavingReport] = useState(false);
  const [sendingReport, setSendingReport] = useState<'daily' | 'full' | null>(null);
  const setRep = <K extends keyof AdminConfig>(k: K, v: AdminConfig[K]) => setReport((prev) => ({ ...prev, [k]: v }));

  const load = async () => {
    if (guestMode) return;
    const { data: u } = await supabase.from('bnf_profiles').select('*').order('created_at', { ascending: false });
    setUsers((u as unknown as Profile[]) ?? []);
    const { data: s } = await supabase.from('bnf_strategies').select('*').order('id');
    setStrategies((s as unknown as Strategy[]) ?? []);
    const { data: cfg } = await supabase.from('bnf_admin_config').select('config').eq('id', 1).maybeSingle();
    if (cfg?.config) setReport({ ...DEFAULT_REPORT, ...(cfg.config as AdminConfig) });
  };
  useEffect(() => { load(); }, []);

  const saveReport = async () => {
    setSavingReport(true);
    await supabase.from('bnf_admin_config').update({ config: report, updated_at: new Date().toISOString() }).eq('id', 1);
    setSavingReport(false);
    flash('리포트 설정 저장 완료');
  };
  const sendNow = async (type: 'daily' | 'full') => {
    // 저장되지 않은 설정이 있을 수 있으므로 먼저 저장
    await supabase.from('bnf_admin_config').update({ config: report, updated_at: new Date().toISOString() }).eq('id', 1);
    const recipient = type === 'daily' ? report.reportRecipient : report.fullReportRecipient;
    if (!recipient) { flash(`${type === 'daily' ? '일일' : '전체'} 리포트 수신 이메일을 먼저 입력·저장하세요.`); return; }
    setSendingReport(type);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) { flash('로그인이 필요합니다.'); return; }
      const res = await fetch('/api/run-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, accessToken: token }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) flash(`${type === 'daily' ? '일일' : '전체'} 리포트를 ${j.recipient}로 발송했습니다.`);
      else flash(`발송 실패: ${j.error ?? `HTTP ${res.status}`}`);
    } catch (e) {
      flash(`발송 실패: ${String(e)}`);
    } finally {
      setSendingReport(null);
    }
  };
  const toggleDay = (d: number) => {
    const cur = report.reportDays ?? [];
    setRep('reportDays', cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort());
  };
  const toggleFullDay = (d: number) => {
    const cur = report.fullReportDays ?? [];
    setRep('fullReportDays', cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort());
  };

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };

  // ── 회원 승인/거절/역할 ──
  const setApproved = async (id: string, approved: boolean) => {
    await supabase.from('bnf_profiles').update({ approved }).eq('id', id);
    flash(approved ? '승인 완료' : '승인 취소됨');
    await load();
  };
  const setRole = async (id: string, role: 'user' | 'admin') => {
    await supabase.from('bnf_profiles').update({ role }).eq('id', id);
    flash('역할 변경 완료');
    await load();
    if (id === me?.id) await refreshProfile();
  };

  // ── 전략 전역 토글 ──
  const toggleStrategy = async (s: Strategy) => {
    await supabase.from('bnf_strategies').update({ enabled: !s.enabled }).eq('id', s.id);
    flash(`${s.name} → ${!s.enabled ? '사용' : '중지'}`);
    await load();
    await refreshProfile();
  };

  // ── 사용자별 전략 권한 ──
  const loadAccess = async (userId: string) => {
    setAccessUser(userId);
    if (!userId) return;
    const { data } = await supabase.from('bnf_user_strategy_access').select('strategy_id, enabled').eq('user_id', userId);
    setAccessMap(new Map((data ?? []).map((a: { strategy_id: number; enabled: boolean }) => [a.strategy_id, a.enabled])));
  };
  const toggleAccess = async (strategyId: number) => {
    if (!accessUser) return;
    const cur = accessMap.get(strategyId);
    const s = strategies.find((x) => x.id === strategyId);
    // 미설정 → 전역값의 반대로 설정, 설정됨 → 토글
    const next = cur == null ? !(s?.enabled ?? true) : !cur;
    await supabase.from('bnf_user_strategy_access').upsert({ user_id: accessUser, strategy_id: strategyId, enabled: next });
    flash('권한 변경 완료');
    await loadAccess(accessUser);
    if (accessUser === me?.id) await refreshProfile();
  };
  const clearAccess = async (strategyId: number) => {
    if (!accessUser) return;
    await supabase.from('bnf_user_strategy_access').delete().eq('user_id', accessUser).eq('strategy_id', strategyId);
    flash('개별 설정 제거 (전역 설정 따름)');
    await loadAccess(accessUser);
    if (accessUser === me?.id) await refreshProfile();
  };

  if (guestMode) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-ink">관리자</h1>
        <div className="card text-sm text-amber-300 bg-amber-500/10 border-amber-500/40">
          게스트 데모 모드에서는 관리자 기능(회원 승인, 전략 권한 관리)을 사용할 수 없습니다.
          <code className="bg-base px-1 rounded mx-1">.env</code>에 Supabase 설정 후 이용하세요.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink">관리자</h1>
          <p className="text-sm text-slate-400 mt-1">회원 승인 · 전략 사용유무 · 사용자별 권한 관리</p>
        </div>
        {msg && <span className="badge bg-profit/20 text-profit">{msg}</span>}
      </header>

      <div className="flex gap-2">
        {([['users', '회원 관리'], ['strategies', '전략 관리'], ['access', '사용자별 전략 권한'], ['report', '스캔 리포트']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} className={tab === t ? 'btn-primary' : 'btn-ghost'} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>

      {/* ── 회원 관리 ── */}
      {tab === 'users' && (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-edge">
                <th className="th">이메일</th><th className="th">이름</th><th className="th">가입일</th>
                <th className="th">역할</th><th className="th">상태</th><th className="th">액션</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-edge/50">
                  <td className="td text-ink">{u.email}{u.id === me?.id && <span className="text-xs text-accent ml-1">(나)</span>}</td>
                  <td className="td">{u.name || '-'}</td>
                  <td className="td text-slate-400">{new Date(u.created_at).toLocaleDateString('ko-KR')}</td>
                  <td className="td">
                    <select
                      className="input !w-auto !py-1"
                      value={u.role}
                      onChange={(e) => setRole(u.id, e.target.value as 'user' | 'admin')}
                      disabled={u.id === me?.id}
                    >
                      <option value="user">일반회원</option>
                      <option value="admin">관리자</option>
                    </select>
                  </td>
                  <td className="td">
                    {u.approved
                      ? <span className="badge bg-profit/20 text-profit">승인됨</span>
                      : <span className="badge bg-amber-500/20 text-amber-400">대기중</span>}
                  </td>
                  <td className="td">
                    {u.approved ? (
                      <button className="text-red-400 hover:underline text-sm" onClick={() => setApproved(u.id, false)} disabled={u.id === me?.id}>
                        승인 취소
                      </button>
                    ) : (
                      <button className="text-profit hover:underline text-sm" onClick={() => setApproved(u.id, true)}>
                        ✓ 승인
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── 전략 관리 (전역 사용유무) ── */}
      {tab === 'strategies' && (
        <div className="space-y-3">
          {strategies.map((s) => (
            <div key={s.id} className="card flex items-start justify-between gap-4">
              <div>
                <div className="font-bold text-ink">{s.name} <span className="text-xs text-slate-500">({s.code})</span></div>
                <p className="text-sm text-slate-400 mt-1 leading-relaxed">{s.description}</p>
                <div className="text-xs text-slate-500 mt-2">
                  파라미터: {Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(' · ')}
                </div>
              </div>
              <button
                className={s.enabled ? 'btn-primary shrink-0' : 'btn-ghost shrink-0'}
                onClick={() => toggleStrategy(s)}
              >
                {s.enabled ? '● 사용 중' : '○ 중지됨'}
              </button>
            </div>
          ))}
          <p className="text-xs text-slate-500">
            전략을 중지하면 개별 권한이 부여되지 않은 모든 회원이 해당 전략(스캐너·백테스트·모의투자)을 사용할 수 없습니다.
          </p>
        </div>
      )}

      {/* ── 사용자별 전략 권한 ── */}
      {tab === 'access' && (
        <div className="card space-y-4">
          <div>
            <label className="text-xs text-slate-400 block mb-1">대상 회원 선택</label>
            <select className="input w-72" value={accessUser} onChange={(e) => loadAccess(e.target.value)}>
              <option value="">회원을 선택하세요</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.email} ({u.name || '이름없음'})</option>)}
            </select>
          </div>
          {accessUser && (
            <table className="w-full">
              <thead>
                <tr className="border-b border-edge">
                  <th className="th">전략</th><th className="th">전역 설정</th><th className="th">개별 설정</th><th className="th">최종 적용</th><th className="th">액션</th>
                </tr>
              </thead>
              <tbody>
                {strategies.map((s) => {
                  const override = accessMap.get(s.id);
                  const effective = override != null ? override : s.enabled;
                  return (
                    <tr key={s.id} className="border-b border-edge/50">
                      <td className="td text-ink">{s.name}</td>
                      <td className="td">{s.enabled ? '사용' : '중지'}</td>
                      <td className="td">
                        {override == null ? <span className="text-slate-500">전역 따름</span> : override ? '허용' : '차단'}
                      </td>
                      <td className="td">
                        <span className={`badge ${effective ? 'bg-profit/20 text-profit' : 'bg-red-500/20 text-red-400'}`}>
                          {effective ? '사용 가능' : '사용 불가'}
                        </span>
                      </td>
                      <td className="td space-x-2">
                        <button className="text-accent hover:underline text-sm" onClick={() => toggleAccess(s.id)}>
                          {effective ? '차단하기' : '허용하기'}
                        </button>
                        {override != null && (
                          <button className="text-slate-400 hover:underline text-sm" onClick={() => clearAccess(s.id)}>
                            개별설정 제거
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── 스캔 리포트 (이메일) ── */}
      {tab === 'report' && (
        <div className="card space-y-4 max-w-2xl">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-ink">일일 이메일 스캔 리포트</h3>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={!!report.reportEnabled} onChange={(e) => setRep('reportEnabled', e.target.checked)} />
              리포트 켜기
            </label>
          </div>
          <p className="text-xs text-slate-500 leading-relaxed">
            설정한 요일·시각(KST)에 전체(또는 시장별) 종목을 선택 전략으로 스캔하여 상위 종목을 이메일로 발송합니다.
            발송에는 Netlify 환경변수 <code className="bg-base px-1 rounded">RESEND_API_KEY</code>(Resend), <code className="bg-base px-1 rounded">SUPABASE_SERVICE_ROLE_KEY</code>가 필요합니다.
          </p>

          <div>
            <label className="text-xs text-slate-400 block mb-1">발송 요일</label>
            <div className="flex gap-2 flex-wrap">
              {DAY_LABELS.map(([d, l]) => (
                <button key={d} onClick={() => toggleDay(d)}
                  className={`px-3 py-1 rounded-md text-sm ${(report.reportDays ?? []).includes(d) ? 'bg-accent text-white' : 'bg-base text-slate-400 border border-edge'}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">발송 시각 (0~23시, KST)</label>
              <input className="input" type="number" min={0} max={23} value={report.reportHour ?? 17} onChange={(e) => setRep('reportHour', Math.min(23, Math.max(0, Number(e.target.value))))} />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">스캔 전략</label>
              <StrategyPicker value={report.reportStrategy ?? 'bnf1'} onChange={(c) => setRep('reportStrategy', c)} className="input w-full" />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">대상 시장</label>
              <select className="input w-full" value={report.reportMarket ?? 'ALL'} onChange={(e) => setRep('reportMarket', e.target.value as AdminConfig['reportMarket'])}>
                <option value="KOSPI">코스피</option>
                <option value="KOSDAQ">코스닥</option>
                <option value="ALL">전체</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">최대 스캔 종목 수</label>
              <input className="input" type="number" min={5} max={200} value={report.reportMaxStocks ?? 60} onChange={(e) => setRep('reportMaxStocks', Math.max(5, Number(e.target.value)))} />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">정렬 기준</label>
              <select className="input w-full" value={report.reportSortBy ?? 'score'} onChange={(e) => setRep('reportSortBy', e.target.value as AdminConfig['reportSortBy'])}>
                <option value="score">조건 점수 높은순</option>
                <option value="changePct">등락률 높은순</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">상위 N개 발송</label>
              <input className="input" type="number" min={1} max={100} value={report.reportTopN ?? 20} onChange={(e) => setRep('reportTopN', Math.max(1, Number(e.target.value)))} />
            </div>
          </div>

          <div>
            <label className="text-xs text-slate-400 block mb-1">수신 이메일</label>
            <input className="input" type="email" value={report.reportRecipient ?? ''} onChange={(e) => setRep('reportRecipient', e.target.value)} placeholder="you@example.com" />
          </div>
          <button className="btn-ghost" onClick={() => sendNow('daily')} disabled={sendingReport !== null}>
            {sendingReport === 'daily' ? '발송 중...' : '📧 일일 리포트 지금 보내기'}
          </button>

          {/* ── 전체 리포트 메일 (전 전략 × 주요 종목) ── */}
          <div className="border-t border-edge pt-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-ink">전체 리포트 메일 (전 전략 × 코스피15 + 코스닥8)</h3>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={!!report.fullReportEnabled} onChange={(e) => setRep('fullReportEnabled', e.target.checked)} />
                켜기
              </label>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
              [전체 리포트] 페이지와 동일한 내용(모든 전략별 단락 + 시세·지표·매수/매도신호·점수·추천도)을 지정한 요일·시각에 이메일로 발송합니다.
            </p>
            <div>
              <label className="text-xs text-slate-400 block mb-1">발송 요일</label>
              <div className="flex gap-2 flex-wrap">
                {DAY_LABELS.map(([d, l]) => (
                  <button key={d} onClick={() => toggleFullDay(d)}
                    className={`px-3 py-1 rounded-md text-sm ${(report.fullReportDays ?? []).includes(d) ? 'bg-accent text-white' : 'bg-base text-slate-400 border border-edge'}`}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-400 block mb-1">발송 시각 (0~23시, KST)</label>
                <input className="input" type="number" min={0} max={23} value={report.fullReportHour ?? 17} onChange={(e) => setRep('fullReportHour', Math.min(23, Math.max(0, Number(e.target.value))))} />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">수신 이메일</label>
                <input className="input" type="email" value={report.fullReportRecipient ?? ''} onChange={(e) => setRep('fullReportRecipient', e.target.value)} placeholder="you@example.com" />
              </div>
            </div>
            <button className="btn-ghost" onClick={() => sendNow('full')} disabled={sendingReport !== null}>
              {sendingReport === 'full' ? '발송 중... (전 전략 스캔, 최대 1분)' : '📧 전체 리포트 지금 보내기'}
            </button>
          </div>

          <button className="btn-primary" onClick={saveReport} disabled={savingReport}>
            {savingReport ? '저장 중...' : '리포트 설정 저장'}
          </button>
        </div>
      )}
    </div>
  );
}
