import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchIndexQuote, fetchCandles, fetchQuote, ALL_STOCKS, stockName, KOSPI_STOCKS, KOSDAQ_STOCKS } from '../lib/marketData';
import { getStrategy, initStrategy } from '../lib/strategies';
import type { StratScan, Tone } from '../lib/strategies/types';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { useStrategySelection } from '../hooks/useStrategySelection';
import StrategyPicker from '../components/StrategyPicker';
import Stars from '../components/Stars';

interface IndexQuote { label: string; price: number; changePct: number }

const DEFAULT_DASH = ['005930.KS', '000660.KS']; // 삼성전자 · SK하이닉스
const MAX_DASH = 5;
const loadDashSymbols = (): string[] => {
  try {
    const s = JSON.parse(localStorage.getItem('dashStocks') ?? 'null');
    return Array.isArray(s) && s.length ? s.slice(0, MAX_DASH) : DEFAULT_DASH;
  } catch { return DEFAULT_DASH; }
};

const toneCls = (t?: Tone) =>
  t === 'up' ? 'text-up' : t === 'down' ? 'text-down' : t === 'accent' ? 'text-accent' : t === 'muted' ? 'text-slate-500' : 'text-slate-200';

export default function DashboardPage() {
  const { profile, guestMode, allowedStrategyCodes } = useAuth();
  const [stratCode, setStratCode] = useStrategySelection();
  const [indices, setIndices] = useState<IndexQuote[]>([]);
  const [dashSymbols, setDashSymbols] = useState<string[]>(loadDashSymbols);
  const [stockQuotes, setStockQuotes] = useState<Record<string, { price: number; changePct: number }>>({});
  const [editStocks, setEditStocks] = useState(false);
  const [signals, setSignals] = useState<StratScan[]>([]);
  const [account, setAccount] = useState<{ cash: number; initial: number; posCount: number } | null>(null);
  const [scanning, setScanning] = useState(true);
  const [demo, setDemo] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const mod = getStrategy(stratCode);
  const enabled = allowedStrategyCodes.includes(stratCode);

  const refresh = useCallback(async () => {
    setScanning(true);
    setDemo(false);
    await initStrategy(mod); // 시장 지수 등 준비 (전략6)
    // 지수
    const [kospi, kosdaq] = await Promise.all([fetchIndexQuote('^KS11'), fetchIndexQuote('^KQ11')]);
    setIndices([
      { label: 'KOSPI', price: kospi.price, changePct: kospi.changePct },
      { label: 'KOSDAQ', price: kosdaq.price, changePct: kosdaq.changePct },
    ]);
    if (kospi.demo) setDemo(true);

    // 개별 종목 카드 (설정된 종목들) 현재가·등락
    await loadStockQuotes(dashSymbols);

    // 오늘 신호: 주요 종목 상위 간이 스캔 (선택 전략)
    const universe = [...KOSPI_STOCKS.slice(0, 6), ...KOSDAQ_STOCKS.slice(0, 2)];
    const results: StratScan[] = [];
    for (const s of universe) {
      try {
        const { candles, demo: d } = await fetchCandles(s.symbol, mod.interval, mod.range);
        if (d) setDemo(true);
        results.push(mod.scan(s.symbol, s.name, mod.compute(candles)));
      } catch { /* skip */ }
    }
    results.sort((a, b) => b.score - a.score);
    setSignals(results);
    setScanning(false);
    setRefreshedAt(new Date());

    // 모의투자 계좌 요약
    if (!guestMode && profile) {
      const { data: acc } = await supabase.from('bnf_paper_accounts').select('*').eq('user_id', profile.id).maybeSingle();
      const { count } = await supabase
        .from('bnf_paper_positions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', profile.id)
        .eq('status', 'OPEN');
      if (acc) setAccount({ cash: Number(acc.cash), initial: Number(acc.initial_balance), posCount: count ?? 0 });
    }
  }, [mod, guestMode, profile, dashSymbols]);

  const loadStockQuotes = async (symbols: string[]) => {
    const entries = await Promise.all(symbols.map(async (sym) => {
      try { const q = await fetchQuote(sym); if (q.demo) setDemo(true); return [sym, { price: q.price, changePct: q.changePct }] as const; }
      catch { return [sym, { price: 0, changePct: 0 }] as const; }
    }));
    setStockQuotes(Object.fromEntries(entries));
  };

  useEffect(() => { refresh(); }, [refresh]);

  const persistDash = (next: string[]) => { setDashSymbols(next); localStorage.setItem('dashStocks', JSON.stringify(next)); };
  const addStock = (sym: string) => {
    if (!sym || dashSymbols.includes(sym) || dashSymbols.length >= MAX_DASH) return;
    const next = [...dashSymbols, sym];
    persistDash(next);
    loadStockQuotes(next);
  };
  const removeStock = (sym: string) => {
    const next = dashSymbols.filter((s) => s !== sym);
    persistDash(next);
    loadStockQuotes(next);
  };

  const fmt = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">대시보드</h1>
          <p className="text-sm text-slate-400 mt-1">{mod.name}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {demo && <span className="badge bg-amber-500/20 text-amber-400">데모 데이터 (실시세 조회 불가 시 합성 데이터)</span>}
          <button className="btn-ghost" onClick={() => setEditStocks((v) => !v)}>🔧 표시 종목 편집</button>
          <StrategyPicker value={stratCode} onChange={setStratCode} />
          <button className="btn-primary" onClick={refresh} disabled={scanning}>
            {scanning ? '갱신 중...' : '🔄 시세 갱신'}
          </button>
        </div>
      </header>
      {refreshedAt && <div className="text-xs text-slate-500 -mt-3">최근 갱신: {refreshedAt.toLocaleString('ko-KR')}</div>}

      {/* 개별 종목 카드 편집 패널 */}
      {editStocks && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-white text-sm">대시보드 표시 종목 ({dashSymbols.length}/{MAX_DASH})</h3>
            <button className="text-slate-500 hover:text-white text-sm" onClick={() => setEditStocks(false)}>✕ 닫기</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {dashSymbols.map((sym) => (
              <span key={sym} className="badge bg-edge text-slate-200 flex items-center gap-1">
                {stockName(sym)}
                <button className="text-red-400 hover:text-red-300 ml-1" onClick={() => removeStock(sym)}>✕</button>
              </span>
            ))}
            {dashSymbols.length === 0 && <span className="text-slate-500 text-sm">표시할 종목이 없습니다.</span>}
          </div>
          <div className="flex items-center gap-2">
            <select
              className="input w-56"
              value=""
              disabled={dashSymbols.length >= MAX_DASH}
              onChange={(e) => { addStock(e.target.value); e.target.value = ''; }}
            >
              <option value="">＋ 종목 추가{dashSymbols.length >= MAX_DASH ? ' (최대 5개)' : ''}</option>
              {ALL_STOCKS.filter((s) => !dashSymbols.includes(s.symbol)).map((s) => (
                <option key={s.symbol} value={s.symbol}>{s.name} ({s.market})</option>
              ))}
            </select>
            <span className="text-xs text-slate-500">최대 5개까지 선택할 수 있습니다.</span>
          </div>
        </div>
      )}

      {!enabled && (
        <div className="card bg-red-500/10 border-red-500/40 text-red-300 text-sm">
          현재 계정에서 해당 전략 사용 권한이 비활성화되어 있습니다. 관리자에게 문의하세요.
        </div>
      )}

      {/* 고정 카드(KOSPI·KOSDAQ·모의투자·활성전략) + 개별종목 카드. 종목 수에 따라 카드 크기 유동 */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        {indices.map((ix) => (
          <div key={ix.label} className="card">
            <div className="text-xs text-slate-400">{ix.label}</div>
            <div className="text-xl font-bold text-white mt-1">{ix.price.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}</div>
            <div className={`text-sm mt-0.5 ${ix.changePct >= 0 ? 'text-up' : 'text-down'}`}>
              {ix.changePct >= 0 ? '▲' : '▼'} {Math.abs(ix.changePct).toFixed(2)}%
            </div>
          </div>
        ))}
        {dashSymbols.map((sym) => {
          const q = stockQuotes[sym];
          return (
            <div key={sym} className="card">
              <div className="text-xs text-slate-400 truncate">{stockName(sym)}</div>
              <div className="text-xl font-bold text-white mt-1">{q ? q.price.toLocaleString('ko-KR', { maximumFractionDigits: 0 }) : '…'}</div>
              <div className={`text-sm mt-0.5 ${(q?.changePct ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                {q ? `${q.changePct >= 0 ? '▲' : '▼'} ${Math.abs(q.changePct).toFixed(2)}%` : '-'}
              </div>
            </div>
          );
        })}
        <div className="card">
          <div className="text-xs text-slate-400">모의투자 가용현금</div>
          <div className="text-xl font-bold text-white mt-1">
            {account ? `${fmt(account.cash)}원` : guestMode ? '게스트 모드' : '계좌 미개설'}
          </div>
          <div className="text-sm text-slate-400 mt-0.5">
            {account ? `보유 포지션 ${account.posCount}건` : <Link to="/paper" className="text-accent">모의투자 시작 →</Link>}
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-400">활성 전략</div>
          <div className="text-xl font-bold text-white mt-1">{mod.name.split('·')[0].trim()}</div>
          <div className={`text-sm mt-0.5 ${enabled ? 'text-profit' : 'text-red-400'}`}>
            {enabled ? '● 사용 가능' : '● 사용 불가'}
          </div>
        </div>
      </div>

      {/* 오늘 신호 */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-white">오늘 신호 · 추천 상위</h2>
          <Link to="/scanner" className="text-sm text-accent hover:underline">전체 스캔 →</Link>
        </div>
        {scanning ? (
          <div className="text-sm text-slate-400 animate-pulse py-8 text-center">주요 종목 스캔 중... ({mod.interval} 데이터 수집)</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-edge">
                  <th className="th">종목</th>
                  <th className="th">현재가</th>
                  <th className="th">등락</th>
                  {mod.colHeaders.map((h) => <th key={h} className="th">{h}</th>)}
                  <th className="th">매수신호</th>
                  <th className="th">매도신호</th>
                  <th className="th">점수</th>
                  <th className="th">추천도</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <tr key={s.symbol} className="border-b border-edge/50 hover:bg-edge/30">
                    <td className="td font-medium text-white">
                      <Link to={`/chart?symbol=${s.symbol}&strat=${stratCode}`} className="hover:text-accent">{s.name}</Link>
                    </td>
                    <td className="td">{fmt(s.price)}</td>
                    <td className={`td ${s.changePct >= 0 ? 'text-up' : 'text-down'}`}>{s.changePct.toFixed(2)}%</td>
                    {s.cols.map((c, i) => <td key={i} className={`td ${toneCls(c.tone)}`}>{c.value}</td>)}
                    <td className="td">{s.buy ? <span className="badge bg-up/20 text-up">매수</span> : <span className="text-slate-500">-</span>}</td>
                    <td className="td">{s.exit ? <span className="badge bg-amber-500/20 text-amber-400">매도</span> : <span className="text-slate-500">-</span>}</td>
                    <td className="td font-bold text-white">{s.score}</td>
                    <td className="td"><Stars n={s.stars} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 전략 규칙 요약 */}
      <div className="card">
        <h2 className="font-bold text-white mb-3">{mod.name} 매매 규칙 요약</h2>
        <div className="grid md:grid-cols-4 gap-3 text-sm">
          {mod.rules.map((r) => (
            <div key={r.tag} className="bg-base rounded-lg p-3 border border-edge">
              <div className={`${r.color} font-semibold mb-1`}>{r.tag} {r.title}</div>
              <div className="text-slate-300 leading-relaxed">{r.body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
