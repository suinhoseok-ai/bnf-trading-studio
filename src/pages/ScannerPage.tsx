import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCandles, universeStocks, UNIVERSE_OPTIONS, stockName } from '../lib/marketData';
import { fetchKisQuotes, type KisQuote } from '../lib/realtimeQuotes';
import { getStrategy, initStrategy } from '../lib/strategies';
import type { StratScan, Tone } from '../lib/strategies/types';
import type { StockDef } from '../lib/types';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { ollamaChat, ruleBasedAnalysis } from '../lib/ollama';
import { useOllamaConfig } from '../hooks/useOllamaConfig';
import { useStrategySelection } from '../hooks/useStrategySelection';
import StrategyPicker from '../components/StrategyPicker';
import Stars from '../components/Stars';

const toneCls = (t?: Tone) =>
  t === 'up' ? 'text-up' : t === 'down' ? 'text-down' : t === 'accent' ? 'text-accent' : t === 'muted' ? 'text-slate-500' : 'text-slate-200';

export default function ScannerPage() {
  const { profile, guestMode, allowedStrategyCodes } = useAuth();
  const [stratCode, setStratCode] = useStrategySelection();
  const [universe, setUniverse] = useState('KOSPI');
  const [results, setResults] = useState<StratScan[]>([]);
  const [scanList, setScanList] = useState<StockDef[]>([]);
  const [scanned, setScanned] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState('');
  const BATCH = 20;
  const [watchlist, setWatchlist] = useState<{ symbol: string; name: string }[]>([]);
  const [aiTarget, setAiTarget] = useState<StratScan | null>(null);
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [ollamaConfig] = useOllamaConfig();
  const [rt, setRt] = useState<{ done: number; total: number; active: boolean } | null>(null);
  const [rtError, setRtError] = useState('');

  const mod = getStrategy(stratCode);
  const enabled = allowedStrategyCodes.includes(stratCode);

  const loadWatchlist = async () => {
    if (guestMode) {
      setWatchlist(JSON.parse(localStorage.getItem('watchlist') ?? '[]'));
      return;
    }
    const { data } = await supabase.from('bnf_watchlist').select('symbol,name').eq('user_id', profile!.id);
    setWatchlist((data as { symbol: string; name: string }[]) ?? []);
  };

  useEffect(() => { loadWatchlist(); }, []);

  const toggleWatch = async (symbol: string, name: string) => {
    const exists = watchlist.some((w) => w.symbol === symbol);
    if (guestMode) {
      const next = exists ? watchlist.filter((w) => w.symbol !== symbol) : [...watchlist, { symbol, name }];
      localStorage.setItem('watchlist', JSON.stringify(next));
      setWatchlist(next);
      return;
    }
    if (exists) await supabase.from('bnf_watchlist').delete().eq('user_id', profile!.id).eq('symbol', symbol);
    else await supabase.from('bnf_watchlist').insert({ user_id: profile!.id, symbol, name });
    await loadWatchlist();
  };

  /** list[from .. from+BATCH] 구간을 스캔해 기존 결과에 누적 */
  const scanBatch = async (list: StockDef[], from: number, prev: StratScan[]) => {
    setScanning(true);
    await initStrategy(mod); // 시장 지수 등 준비 (전략6)
    const out = [...prev];
    const to = Math.min(from + BATCH, list.length);
    for (let i = from; i < to; i++) {
      const s = list[i];
      setProgress(`${i + 1}/${list.length} · ${s.name} 분석 중...`);
      try {
        const { candles } = await fetchCandles(s.symbol, mod.interval, mod.range);
        out.push(mod.scan(s.symbol, s.name, mod.compute(candles)));
      } catch (e) {
        out.push({ symbol: s.symbol, name: s.name, price: 0, changePct: 0, buy: false, exit: false, score: 0, stars: 1, cols: mod.colHeaders.map(() => ({ value: '-' })), conditions: [], error: String(e) });
      }
      setResults([...out].sort((a, b) => b.score - a.score));
    }
    setScanned(to);
    setProgress('');
    setScanning(false);
  };

  const runScan = async () => {
    if (!enabled) return;
    const list: StockDef[] =
      universe === 'WATCH'
        ? watchlist.map((w) => ({ symbol: w.symbol, name: w.name || stockName(w.symbol), market: 'KOSPI' as const }))
        : universeStocks(universe);
    setScanList(list);
    setResults([]);
    setScanned(0);
    setRt(null);
    setRtError('');
    await scanBatch(list, 0, []);
  };

  // 현재 스캔 결과의 가격·등락률을 KIS 실시간 시세로 덮어쓴다 (신호 판정은 Yahoo 캔들 기준 유지).
  const goRealtime = async () => {
    setRtError('');
    const symbols = results.map((r) => r.symbol);
    if (!symbols.length) return;
    setRt({ done: 0, total: symbols.length, active: true });
    const acc: Record<string, KisQuote> = {};
    try {
      await fetchKisQuotes(symbols, (done, total, quotes) => {
        for (const q of quotes) acc[q.symbol] = q;
        setResults((prev) => prev.map((r) => {
          const q = acc[r.symbol];
          return q ? { ...r, price: q.price, changePct: q.changePct } : r;
        }));
        setRt({ done, total, active: true });
      });
    } catch (e) {
      setRtError(e instanceof Error ? e.message : String(e));
      setRt(null);
    }
  };

  const scanMore = async () => {
    if (scanning || scanned >= scanList.length) return;
    await scanBatch(scanList, scanned, results);
  };

  const analyzeWithAI = async (r: StratScan) => {
    setAiTarget(r);
    setAiText('');
    setAiBusy(true);
    const met = r.conditions.filter((c) => c.met).length;
    const context = [
      `전략: ${mod.name}`,
      `종목: ${r.name} (${r.symbol})`,
      `현재가: ${r.price.toLocaleString('ko-KR')}원 (${r.changePct.toFixed(2)}%)`,
      ...mod.colHeaders.map((h, i) => `${h}: ${r.cols[i]?.value ?? '-'}`),
      `매수 신호: ${r.buy ? '발생' : '없음'} · 매도(청산) 신호: ${r.exit ? '발생' : '없음'}`,
      `조건 충족: ${r.conditions.length}개 중 ${met}개 · 점수 ${r.score}/100 · 추천도 ${'★'.repeat(r.stars)}`,
      '충족 상세: ' + r.conditions.map((c) => `${c.label}=${c.met ? 'O' : 'X'}`).join(', '),
    ].join('\n');
    try {
      const answer = await ollamaChat(ollamaConfig, [
        { role: 'user', content: `다음 스캔 결과를 초보자도 이해할 수 있게 분석·설명하고 추천도(★1~5)와 근거를 제시해줘.\n\n${context}` },
      ]);
      setAiText(answer);
    } catch {
      setAiText(ruleBasedAnalysis(context));
    }
    setAiBusy(false);
  };

  const colCount = 6 + mod.colHeaders.length + 2; // 관심,종목,현재가,등락 + cols + 매수,매도 + 점수,추천도,액션 조정
  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">종목 스캐너</h1>
          <p className="text-sm text-slate-400 mt-1">{mod.short}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <StrategyPicker value={stratCode} onChange={setStratCode} />
          <select className="input w-auto" value={universe} onChange={(e) => setUniverse(e.target.value)}>
            {UNIVERSE_OPTIONS.map((u) => (
              <option key={u.key} value={u.key}>{u.key === 'WATCH' ? `관심종목 (${watchlist.length})` : u.label}</option>
            ))}
          </select>
          <button className="btn-primary" onClick={runScan} disabled={scanning || !enabled}>
            {scanning ? '스캔 중...' : '스캔 실행'}
          </button>
          {!guestMode && results.length > 0 && (
            <button
              className="btn-ghost"
              onClick={goRealtime}
              disabled={scanning || (!!rt && rt.done < rt.total)}
              title="한국투자증권(KIS)에서 지연 없는 실시간 시세로 현재가·등락을 덮어씁니다. (종목이 많으면 시간이 걸립니다)"
            >
              {rt && rt.done < rt.total ? `⚡ 실시간 조회 중… ${rt.done}/${rt.total}` : '⚡ 실시간(KIS)'}
            </button>
          )}
        </div>
      </header>
      {results.length > 0 && (
        <div className="text-xs flex items-center gap-2 flex-wrap">
          {rt?.active ? (
            <span className="badge bg-up/20 text-up">⚡ 현재가·등락 = 실시간(KIS)</span>
          ) : (
            <span className="badge bg-edge text-slate-400">현재가 = Yahoo · 약 15~20분 지연</span>
          )}
          <span className="text-slate-500">※ 매수/매도 신호 판정은 항상 Yahoo 캔들 기준입니다.</span>
          {rtError && <span className="text-red-400">실시간 조회 실패: {rtError}</span>}
        </div>
      )}

      {!enabled && (
        <div className="card bg-red-500/10 border-red-500/40 text-red-300 text-sm">
          해당 전략 사용 권한이 없습니다. 관리자에게 문의하세요.
        </div>
      )}
      {progress && <div className="text-sm text-accent animate-pulse">{progress}</div>}

      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-edge">
              <th className="th">관심</th>
              <th className="th">종목</th>
              <th className="th">현재가</th>
              <th className="th">등락</th>
              {mod.colHeaders.map((h) => <th key={h} className="th">{h}</th>)}
              <th className="th">매수신호</th>
              <th className="th">매도신호</th>
              <th className="th">점수</th>
              <th className="th">추천도</th>
              <th className="th">액션</th>
            </tr>
          </thead>
          <tbody>
            {results.length === 0 && !scanning && (
              <tr><td colSpan={colCount + 3} className="td text-center text-slate-500 py-10">[스캔 실행]을 눌러 종목 검사를 시작하세요.</td></tr>
            )}
            {results.map((r) => (
              <tr key={r.symbol} className="border-b border-edge/50 hover:bg-edge/30">
                <td className="td">
                  <button onClick={() => toggleWatch(r.symbol, r.name)} title="관심종목 토글">
                    {watchlist.some((w) => w.symbol === r.symbol) ? '⭐' : '☆'}
                  </button>
                </td>
                <td className="td font-medium text-ink">
                  <Link to={`/chart?symbol=${r.symbol}&strat=${stratCode}`} className="hover:text-accent" title="차트 보기">{r.name}</Link>
                </td>
                <td className="td">{r.price.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}</td>
                <td className={`td ${r.changePct >= 0 ? 'text-up' : 'text-down'}`}>{r.changePct.toFixed(2)}%</td>
                {r.cols.map((c, i) => <td key={i} className={`td ${toneCls(c.tone)}`}>{c.value}</td>)}
                <td className="td">{r.buy ? <span className="badge bg-up/20 text-up">매수</span> : <span className="text-slate-500">-</span>}</td>
                <td className="td">{r.exit ? <span className="badge bg-amber-500/20 text-amber-400">매도</span> : <span className="text-slate-500">-</span>}</td>
                <td className="td font-bold text-ink">{r.score}</td>
                <td className="td"><Stars n={r.stars} /></td>
                <td className="td space-x-2">
                  <Link to={`/chart?symbol=${r.symbol}&strat=${stratCode}`} className="text-accent hover:underline text-sm">차트</Link>
                  <button className="text-purple-400 hover:underline text-sm" onClick={() => analyzeWithAI(r)}>AI분석</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {scanList.length > 0 && scanned < scanList.length && (
        <div className="text-center">
          <button className="btn-ghost" onClick={scanMore} disabled={scanning}>
            {scanning ? '스캔 중...' : `종목 더 보기 (+${Math.min(BATCH, scanList.length - scanned)}) · ${scanned}/${scanList.length}`}
          </button>
        </div>
      )}

      {aiTarget && (
        <div className="card border-purple-500/40">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-bold text-purple-300">🤖 Qwen3 AI 분석 — {aiTarget.name}</h3>
            <button className="text-slate-500 hover:text-ink" onClick={() => setAiTarget(null)}>✕</button>
          </div>
          {aiBusy ? (
            <div className="text-sm text-slate-400 animate-pulse py-4">Qwen3가 분석 중입니다...</div>
          ) : (
            <pre className="text-sm text-slate-200 whitespace-pre-wrap font-sans leading-relaxed">{aiText}</pre>
          )}
        </div>
      )}
    </div>
  );
}
