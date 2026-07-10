import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCandles, KOSPI_STOCKS, KOSDAQ_STOCKS, stockName } from '../lib/marketData';
import { calcIndicators } from '../lib/indicators';
import { scoreSymbol } from '../lib/scanner';
import type { ScanResult, StockDef } from '../lib/types';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { ollamaChat, ruleBasedAnalysis } from '../lib/ollama';
import { useOllamaConfig } from '../hooks/useOllamaConfig';
import Stars from '../components/Stars';

type Universe = 'KOSPI' | 'KOSDAQ' | 'WATCH';

export default function ScannerPage() {
  const { profile, guestMode, allowedStrategyCodes } = useAuth();
  const [universe, setUniverse] = useState<Universe>('KOSPI');
  const [results, setResults] = useState<ScanResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState('');
  const [watchlist, setWatchlist] = useState<{ symbol: string; name: string }[]>([]);
  const [aiTarget, setAiTarget] = useState<ScanResult | null>(null);
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [ollamaConfig] = useOllamaConfig();

  const bnfEnabled = allowedStrategyCodes.includes('bnf1');

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

  const runScan = async () => {
    if (!bnfEnabled) return;
    setScanning(true);
    setResults([]);
    const list: StockDef[] =
      universe === 'KOSPI' ? KOSPI_STOCKS
      : universe === 'KOSDAQ' ? KOSDAQ_STOCKS
      : watchlist.map((w) => ({ symbol: w.symbol, name: w.name || stockName(w.symbol), market: 'KOSPI' as const }));

    const out: ScanResult[] = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      setProgress(`${i + 1}/${list.length} · ${s.name} 분석 중...`);
      try {
        const { candles } = await fetchCandles(s.symbol, '15m', '60d');
        const rows = calcIndicators(candles);
        out.push(scoreSymbol(s.symbol, s.name, rows));
      } catch (e) {
        out.push({ symbol: s.symbol, name: s.name, price: 0, changePct: 0, bandwidth: null, bwPctRank: null, isSqueezed: false, belowLower: false, score: 0, stars: 1, conditions: [], error: String(e) });
      }
      setResults([...out].sort((a, b) => b.score - a.score));
    }
    setProgress('');
    setScanning(false);
  };

  const analyzeWithAI = async (r: ScanResult) => {
    setAiTarget(r);
    setAiText('');
    setAiBusy(true);
    const met = r.conditions.filter((c) => c.met).length;
    const context = [
      `종목: ${r.name} (${r.symbol})`,
      `현재가: ${r.price.toLocaleString('ko-KR')}원 (${r.changePct.toFixed(2)}%)`,
      `밴드폭: ${r.bandwidth != null ? (r.bandwidth * 100).toFixed(2) + '%' : 'N/A'} · 최근 100봉 중 하위 ${r.bwPctRank ?? '-'}%`,
      `수렴(Squeeze) 상태: ${r.isSqueezed ? '예' : '아니오'} · 하단밴드 이탈: ${r.belowLower ? '예' : '아니오'}`,
      `BNF1 조건 충족: ${r.conditions.length}개 중 ${met}개 · 점수 ${r.score}/100 · 추천도 ${'★'.repeat(r.stars)}`,
      '충족 상세: ' + r.conditions.map((c) => `${c.label}=${c.met ? 'O' : 'X'}`).join(', '),
    ].join('\n');
    try {
      const answer = await ollamaChat(ollamaConfig, [
        { role: 'user', content: `다음 BNF 전략1 스캔 결과를 초보자도 이해할 수 있게 분석·설명하고 추천도(★1~5)와 근거를 제시해줘.\n\n${context}` },
      ]);
      setAiText(answer);
    } catch {
      setAiText(ruleBasedAnalysis(context));
    }
    setAiBusy(false);
  };

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">종목 스캐너</h1>
          <p className="text-sm text-slate-400 mt-1">15분봉 기준 BNF 전략1 조건 충족도 검사 (100점 만점)</p>
        </div>
        <div className="flex items-center gap-2">
          <select className="input w-auto" value={universe} onChange={(e) => setUniverse(e.target.value as Universe)}>
            <option value="KOSPI">KOSPI 주요종목</option>
            <option value="KOSDAQ">KOSDAQ 주요종목</option>
            <option value="WATCH">관심종목 ({watchlist.length})</option>
          </select>
          <button className="btn-primary" onClick={runScan} disabled={scanning || !bnfEnabled}>
            {scanning ? '스캔 중...' : '스캔 실행'}
          </button>
        </div>
      </header>

      {!bnfEnabled && (
        <div className="card bg-red-500/10 border-red-500/40 text-red-300 text-sm">
          BNF 전략1 사용 권한이 없습니다. 관리자에게 문의하세요.
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
              <th className="th">밴드폭</th>
              <th className="th">BW 백분위</th>
              <th className="th">수렴</th>
              <th className="th">하단이탈</th>
              <th className="th">점수</th>
              <th className="th">추천도</th>
              <th className="th">액션</th>
            </tr>
          </thead>
          <tbody>
            {results.length === 0 && !scanning && (
              <tr><td colSpan={11} className="td text-center text-slate-500 py-10">[스캔 실행]을 눌러 종목 검사를 시작하세요.</td></tr>
            )}
            {results.map((r) => (
              <tr key={r.symbol} className="border-b border-edge/50 hover:bg-edge/30">
                <td className="td">
                  <button onClick={() => toggleWatch(r.symbol, r.name)} title="관심종목 토글">
                    {watchlist.some((w) => w.symbol === r.symbol) ? '⭐' : '☆'}
                  </button>
                </td>
                <td className="td font-medium text-white">{r.name}</td>
                <td className="td">{r.price.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}</td>
                <td className={`td ${r.changePct >= 0 ? 'text-up' : 'text-down'}`}>{r.changePct.toFixed(2)}%</td>
                <td className="td">{r.bandwidth != null ? (r.bandwidth * 100).toFixed(2) + '%' : '-'}</td>
                <td className="td">{r.bwPctRank != null ? `하위 ${r.bwPctRank}%` : '-'}</td>
                <td className="td">{r.isSqueezed ? <span className="badge bg-accent/20 text-accent">수렴</span> : '-'}</td>
                <td className="td">{r.belowLower ? <span className="badge bg-up/20 text-up">매수신호</span> : '-'}</td>
                <td className="td font-bold text-white">{r.score}</td>
                <td className="td"><Stars n={r.stars} /></td>
                <td className="td space-x-2">
                  <Link to={`/chart?symbol=${r.symbol}`} className="text-accent hover:underline text-sm">차트</Link>
                  <button className="text-purple-400 hover:underline text-sm" onClick={() => analyzeWithAI(r)}>AI분석</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* AI 분석 패널 */}
      {aiTarget && (
        <div className="card border-purple-500/40">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-bold text-purple-300">🤖 Qwen3 AI 분석 — {aiTarget.name}</h3>
            <button className="text-slate-500 hover:text-white" onClick={() => setAiTarget(null)}>✕</button>
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
