import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchIndexQuote, fetchCandles, fetchQuote, ALL_STOCKS, stockName, KOSPI_STOCKS, KOSDAQ_STOCKS } from '../lib/marketData';
import { fetchKisQuotes, type KisQuote } from '../lib/realtimeQuotes';
import { getStrategy, initStrategy } from '../lib/strategies';
import type { StratScan, Tone } from '../lib/strategies/types';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { useStrategySelection } from '../hooks/useStrategySelection';
import StrategyPicker from '../components/StrategyPicker';
import Stars from '../components/Stars';
import { judgeBothMarkets, regimeIcon, regimeLabel, type RegimeResult, type Regime, type CandleFetcher } from '../lib/marketRegime';
import { recommendForRegime } from '../lib/strategyRecommend';

interface IndexQuote { label: string; price: number; changePct: number }
interface RegimeState { kospi: RegimeResult; kosdaq: RegimeResult; source: 'db' | 'client'; judgedAt?: string; session?: string }
interface RegimeHistoryRow { trade_date: string; kospi_regime: Regime; kosdaq_regime: Regime }

const regimeFetcher: CandleFetcher = async (symbol, interval, range) => {
  const { candles } = await fetchCandles(symbol, interval as '15m' | '60m' | '1d', range);
  return candles;
};

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
  const [rt, setRt] = useState<{ done: number; total: number; active: boolean } | null>(null);
  const [rtError, setRtError] = useState('');
  const [regime, setRegime] = useState<RegimeState | null>(null);
  const [regimeHistory, setRegimeHistory] = useState<RegimeHistoryRow[]>([]);
  const [regimeExpanded, setRegimeExpanded] = useState(false);

  const mod = getStrategy(stratCode);
  const enabled = allowedStrategyCodes.includes(stratCode);

  const loadRegime = useCallback(async () => {
    if (!guestMode) {
      const { data } = await supabase.from('bnf_market_regime').select('*')
        .order('judged_at', { ascending: false }).limit(1).maybeSingle();
      if (data) {
        const detail = data.detail as { kospi: RegimeResult; kosdaq: RegimeResult };
        setRegime({ kospi: detail.kospi, kosdaq: detail.kosdaq, source: 'db', judgedAt: data.judged_at as string, session: data.session as string });
        const { data: hist } = await supabase.from('bnf_market_regime')
          .select('trade_date, kospi_regime, kosdaq_regime').eq('session', 'close')
          .order('trade_date', { ascending: false }).limit(7);
        setRegimeHistory(((hist ?? []) as RegimeHistoryRow[]).slice().reverse());
        return;
      }
    }
    // 폴백: DB 판정 이력이 없거나 게스트 모드 → 클라이언트에서 직접 계산 (히스테리시스/7일 추이 없음)
    try {
      const { kospi, kosdaq } = await judgeBothMarkets(regimeFetcher);
      setRegime({ kospi, kosdaq, source: 'client' });
      setRegimeHistory([]);
    } catch { setRegime(null); }
  }, [guestMode]);

  const refresh = useCallback(async () => {
    setScanning(true);
    setDemo(false);
    setRt(null);
    setRtError('');
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
    await loadRegime();

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
  }, [mod, guestMode, profile, dashSymbols, loadRegime]);

  const loadStockQuotes = async (symbols: string[]) => {
    const entries = await Promise.all(symbols.map(async (sym) => {
      try { const q = await fetchQuote(sym); if (q.demo) setDemo(true); return [sym, { price: q.price, changePct: q.changePct }] as const; }
      catch { return [sym, { price: 0, changePct: 0 }] as const; }
    }));
    setStockQuotes(Object.fromEntries(entries));
  };

  // 실시간(KIS) 시세를 현재 화면 상태(지수·종목카드·신호표)에 덮어쓴다.
  const applyRealtime = (map: Record<string, KisQuote>) => {
    setIndices((prev) => prev.map((ix) => {
      const code = ix.label === 'KOSPI' ? '^KS11' : ix.label === 'KOSDAQ' ? '^KQ11' : '';
      const q = map[code];
      return q ? { ...ix, price: q.price, changePct: q.changePct } : ix;
    }));
    setStockQuotes((prev) => {
      const next = { ...prev };
      for (const sym of Object.keys(next)) {
        const q = map[sym];
        if (q) next[sym] = { price: q.price, changePct: q.changePct };
      }
      return next;
    });
    setSignals((prev) => prev.map((s) => {
      const q = map[s.symbol];
      return q ? { ...s, price: q.price, changePct: q.changePct } : s;
    }));
  };

  const goRealtime = async () => {
    setRtError('');
    const symbols = ['^KS11', '^KQ11', ...dashSymbols, ...signals.map((s) => s.symbol)];
    const uniq = [...new Set(symbols)];
    setRt({ done: 0, total: uniq.length, active: true });
    const acc: Record<string, KisQuote> = {};
    try {
      await fetchKisQuotes(uniq, (done, total, quotes) => {
        for (const q of quotes) acc[q.symbol] = q;
        applyRealtime(acc);
        setRt({ done, total, active: true });
      });
      setRefreshedAt(new Date());
    } catch (e) {
      setRtError(e instanceof Error ? e.message : String(e));
      setRt(null);
    }
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
          <h1 className="text-2xl font-bold text-ink">대시보드</h1>
          <p className="text-sm text-slate-400 mt-1">{mod.name}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {demo && <span className="badge bg-amber-500/20 text-amber-400">데모 데이터 (실시세 조회 불가 시 합성 데이터)</span>}
          <button className="btn-ghost" onClick={() => setEditStocks((v) => !v)}>🔧 표시 종목 편집</button>
          <StrategyPicker value={stratCode} onChange={setStratCode} />
          <button className="btn-primary" onClick={refresh} disabled={scanning || !!rt?.active}>
            {scanning ? '갱신 중...' : '🔄 시세 갱신'}
          </button>
          {!guestMode && (
            <button
              className="btn-ghost"
              onClick={goRealtime}
              disabled={scanning || (!!rt && rt.done < rt.total)}
              title="한국투자증권(KIS)에서 지연 없는 실시간 시세를 조회해 덮어씁니다."
            >
              {rt && rt.done < rt.total ? `⚡ 실시간 조회 중… ${rt.done}/${rt.total}` : '⚡ 실시간(KIS)'}
            </button>
          )}
        </div>
      </header>
      {refreshedAt && (
        <div className="text-xs text-slate-500 -mt-3 flex items-center gap-2 flex-wrap">
          <span>최근 갱신: {refreshedAt.toLocaleString('ko-KR')}</span>
          {rt?.active ? (
            <span className="badge bg-up/20 text-up">⚡ 실시간 시세(KIS)</span>
          ) : (
            <span className="badge bg-edge text-slate-400">Yahoo · 약 15~20분 지연</span>
          )}
          {rtError && <span className="text-red-400">실시간 조회 실패: {rtError}</span>}
        </div>
      )}

      {/* 개별 종목 카드 편집 패널 */}
      {editStocks && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-ink text-sm">대시보드 표시 종목 ({dashSymbols.length}/{MAX_DASH})</h3>
            <button className="text-slate-500 hover:text-ink text-sm" onClick={() => setEditStocks(false)}>✕ 닫기</button>
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
            <div className="text-xl font-bold text-ink mt-1">{ix.price.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}</div>
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
              <div className="text-xl font-bold text-ink mt-1">{q ? q.price.toLocaleString('ko-KR', { maximumFractionDigits: 0 }) : '…'}</div>
              <div className={`text-sm mt-0.5 ${(q?.changePct ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>
                {q ? `${q.changePct >= 0 ? '▲' : '▼'} ${Math.abs(q.changePct).toFixed(2)}%` : '-'}
              </div>
            </div>
          );
        })}
        <div className="card">
          <div className="text-xs text-slate-400">모의투자 가용현금</div>
          <div className="text-xl font-bold text-ink mt-1">
            {account ? `${fmt(account.cash)}원` : guestMode ? '게스트 모드' : '계좌 미개설'}
          </div>
          <div className="text-sm text-slate-400 mt-0.5">
            {account ? `보유 포지션 ${account.posCount}건` : <Link to="/paper" className="text-accent">모의투자 시작 →</Link>}
          </div>
        </div>
        <div className="card cursor-pointer hover:border-accent/50" onClick={() => setRegimeExpanded((v) => !v)}>
          <div className="text-xs text-slate-400 flex items-center justify-between">
            <span>시장현황</span>
            {regime && <span className="text-slate-500">{regimeExpanded ? '접기 ▲' : '근거 보기 ▼'}</span>}
          </div>
          {regime ? (
            <>
              <div className="text-xl font-bold text-ink mt-1">{regimeIcon(regime.kospi.regime)} {regimeLabel(regime.kospi.regime)}</div>
              <div className="text-sm text-slate-400 mt-0.5">
                KOSPI {regimeIcon(regime.kospi.regime)} · KOSDAQ {regimeIcon(regime.kosdaq.regime)}
                {regime.source === 'client' && <span className="ml-1 text-slate-500">(간이계산)</span>}
              </div>
            </>
          ) : (
            <div className="text-sm text-slate-500 mt-2">판정 전</div>
          )}
        </div>
      </div>

      {/* 시장현황 확장 패널: 판정 근거 + 추천전략 + 최근 7일 추이 */}
      {regimeExpanded && regime && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-ink text-sm">
              시장국면 판정 근거
              {regime.judgedAt && <span className="text-slate-500 font-normal ml-2 text-xs">
                {new Date(regime.judgedAt).toLocaleString('ko-KR')} · {regime.session === 'preopen' ? '장전' : regime.session === 'midday' ? '장중' : regime.session === 'close' ? '장마감' : ''}
              </span>}
            </h3>
            <button className="text-slate-500 hover:text-ink text-sm" onClick={() => setRegimeExpanded(false)}>✕ 접기</button>
          </div>

          {(['kospi', 'kosdaq'] as const).map((key) => {
            const r = regime[key];
            const rec = recommendForRegime(r.regime);
            return (
              <div key={key} className="bg-base rounded-lg p-3 border border-edge">
                <div className="font-semibold text-ink mb-2">
                  {key.toUpperCase()} — {regimeIcon(r.regime)} {regimeLabel(r.regime)}
                  <span className="text-xs text-slate-500 font-normal ml-2">
                    (상승 {r.score.bull}/6 · 횡보 {r.score.sideways}/5 · 하락 {r.score.bear}/6)
                  </span>
                </div>
                <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm mb-2">
                  {r.evidence.map((e) => (
                    <div key={e.label} className={e.met ? 'text-up' : 'text-slate-500'}>
                      {e.met ? '✓' : '✗'} {e.label} <span className="text-slate-500">({e.value})</span>
                    </div>
                  ))}
                </div>
                <div className="text-xs text-accent">
                  추천 전략: {rec.primary ? rec.primary.name.split('·')[0].trim() : '없음(위험도 기준 미충족)'}
                  {rec.secondary && ` · 차선: ${rec.secondary.name.split('·')[0].trim()}`}
                  {r.regime === 'BEAR' && ' · 현금 비중 확대 권고'}
                </div>
              </div>
            );
          })}

          {regimeHistory.length > 0 && (
            <div>
              <div className="text-xs text-slate-400 mb-1">최근 {regimeHistory.length}거래일 장마감 국면 추이</div>
              <div className="flex gap-2 flex-wrap">
                {regimeHistory.map((h) => (
                  <div key={h.trade_date} className="text-xs bg-base border border-edge rounded-lg px-2 py-1 text-center">
                    <div className="text-slate-500">{h.trade_date.slice(5)}</div>
                    <div>{regimeIcon(h.kospi_regime)}{regimeIcon(h.kosdaq_regime)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 오늘 신호 */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-ink">오늘 신호 · 추천 상위</h2>
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
                    <td className="td font-medium text-ink">
                      <Link to={`/chart?symbol=${s.symbol}&strat=${stratCode}`} className="hover:text-accent">{s.name}</Link>
                    </td>
                    <td className="td">{fmt(s.price)}</td>
                    <td className={`td ${s.changePct >= 0 ? 'text-up' : 'text-down'}`}>{s.changePct.toFixed(2)}%</td>
                    {s.cols.map((c, i) => <td key={i} className={`td ${toneCls(c.tone)}`}>{c.value}</td>)}
                    <td className="td">{s.buy ? <span className="badge bg-up/20 text-up">매수</span> : <span className="text-slate-500">-</span>}</td>
                    <td className="td">{s.exit ? <span className="badge bg-amber-500/20 text-amber-400">매도</span> : <span className="text-slate-500">-</span>}</td>
                    <td className="td font-bold text-ink">{s.score}</td>
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
        <h2 className="font-bold text-ink mb-3">{mod.name} 매매 규칙 요약</h2>
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
