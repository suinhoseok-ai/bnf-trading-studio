import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCandles, fetchQuote, KOSPI_STOCKS, KOSDAQ_STOCKS, fmtKRWLarge, Quote } from '../lib/marketData';
import { ALL_STRATEGIES, initStrategy } from '../lib/strategies';
import type { StratScan, Tone, StrategyModule } from '../lib/strategies/types';
import { useAuth } from '../context/AuthContext';
import Stars from '../components/Stars';

const REPORT_STOCKS = [...KOSPI_STOCKS, ...KOSDAQ_STOCKS]; // 코스피 15 + 코스닥 8

interface Section { mod: StrategyModule; scans: StratScan[] }

const toneCls = (t?: Tone) =>
  t === 'up' ? 'text-up' : t === 'down' ? 'text-down' : t === 'accent' ? 'text-accent' : t === 'muted' ? 'text-slate-500' : 'text-slate-200';

export default function ReportPage() {
  const { allowedStrategyCodes } = useAuth();
  const [sections, setSections] = useState<Section[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [generatedAt, setGeneratedAt] = useState<Date | null>(null);

  const mods = ALL_STRATEGIES.filter((m) => allowedStrategyCodes.includes(m.code));

  const run = async () => {
    setRunning(true);
    setSections([]);
    setGeneratedAt(null);
    try {
      // 1. 시세 요약 (1d) — 종목당 1회
      const qmap: Record<string, Quote> = {};
      for (let i = 0; i < REPORT_STOCKS.length; i++) {
        const s = REPORT_STOCKS[i];
        setProgress(`시세 수집 ${i + 1}/${REPORT_STOCKS.length} · ${s.name}`);
        try { qmap[s.symbol] = await fetchQuote(s.symbol); } catch { /* skip */ }
      }
      setQuotes(qmap);

      // 2. 전략별 스캔 (캔들은 interval별 캐시 재사용)
      const out: Section[] = [];
      for (const mod of mods) {
        await initStrategy(mod);
        const scans: StratScan[] = [];
        for (let i = 0; i < REPORT_STOCKS.length; i++) {
          const s = REPORT_STOCKS[i];
          setProgress(`${mod.name.split('·')[0].trim()} 스캔 ${i + 1}/${REPORT_STOCKS.length} · ${s.name}`);
          try {
            const { candles } = await fetchCandles(s.symbol, mod.interval, mod.range);
            scans.push(mod.scan(s.symbol, s.name, mod.compute(candles)));
          } catch { /* skip */ }
        }
        scans.sort((a, b) => b.score - a.score);
        out.push({ mod, scans });
        setSections([...out]);
      }
      setGeneratedAt(new Date());
    } finally {
      setProgress('');
      setRunning(false);
    }
  };

  const fmt = (n: number | undefined | null) => (n == null || n === 0 ? '-' : n.toLocaleString('ko-KR', { maximumFractionDigits: 0 }));

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">전체 리포트</h1>
          <p className="text-sm text-slate-400 mt-1">
            코스피({KOSPI_STOCKS.length}) · 코스닥({KOSDAQ_STOCKS.length}) 주요종목 × 전체 전략({mods.length}) 종합 스캔
          </p>
        </div>
        <div className="flex items-center gap-3">
          {generatedAt && <span className="text-xs text-slate-500">생성: {generatedAt.toLocaleString('ko-KR')}</span>}
          <button className="btn-primary" onClick={run} disabled={running}>
            {running ? '리포트 생성 중...' : '📑 리포트 생성'}
          </button>
        </div>
      </header>

      {progress && <div className="text-sm text-accent animate-pulse">{progress}</div>}
      {sections.length === 0 && !running && (
        <div className="card text-center text-slate-500 py-14">[리포트 생성]을 누르면 모든 전략에 대한 종합 스캔 리포트를 작성합니다.</div>
      )}

      {sections.map(({ mod, scans }) => (
        <div key={mod.code} className="card space-y-2">
          <div>
            <h2 className="font-bold text-ink">{mod.name}</h2>
            <p className="text-xs text-slate-500 mt-0.5">{mod.short}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap">
              <thead>
                <tr className="border-b border-edge">
                  <th className="th">종목</th><th className="th">현재가</th><th className="th">등락</th>
                  <th className="th">전일</th><th className="th">고가</th><th className="th">저가</th>
                  <th className="th">거래량</th><th className="th">대금</th>
                  {mod.colHeaders.map((h) => <th key={h} className="th">{h}</th>)}
                  <th className="th">매수신호</th><th className="th">매도신호</th><th className="th">점수</th><th className="th">추천도</th>
                </tr>
              </thead>
              <tbody>
                {scans.map((r) => {
                  const q = quotes[r.symbol];
                  return (
                    <tr key={r.symbol} className="border-b border-edge/50 hover:bg-edge/30">
                      <td className="td font-medium text-ink">
                        <Link to={`/chart?symbol=${r.symbol}&strat=${mod.code}`} className="hover:text-accent">{r.name}</Link>
                      </td>
                      <td className="td text-ink">{fmt(r.price)}</td>
                      <td className={`td ${r.changePct >= 0 ? 'text-up' : 'text-down'}`}>{r.changePct.toFixed(2)}%</td>
                      <td className="td text-slate-400">{fmt(q?.prevClose)}</td>
                      <td className="td text-up">{fmt(q?.high)}</td>
                      <td className="td text-down">{fmt(q?.low)}</td>
                      <td className="td">{fmt(q?.volume)}</td>
                      <td className="td">{fmtKRWLarge(q?.tradeValue)}</td>
                      {r.cols.map((c, i) => <td key={i} className={`td ${toneCls(c.tone)}`}>{c.value}</td>)}
                      <td className="td">{r.buy ? <span className="badge bg-up/20 text-up">매수</span> : <span className="text-slate-500">-</span>}</td>
                      <td className="td">{r.exit ? <span className="badge bg-amber-500/20 text-amber-400">매도</span> : <span className="text-slate-500">-</span>}</td>
                      <td className="td font-bold text-ink">{r.score}</td>
                      <td className="td"><Stars n={r.stars} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
