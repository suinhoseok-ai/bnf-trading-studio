import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchCandles, ALL_STOCKS, RANGE_BY_INTERVAL, Interval, stockName } from '../lib/marketData';
import { getStrategy, simulate, initStrategy } from '../lib/strategies';
import type { StratRow } from '../lib/strategies/types';
import type { TradeEvent } from '../lib/types';
import { analyzeChart } from '../lib/analysis';
import { useStrategySelection } from '../hooks/useStrategySelection';
import StrategyPicker from '../components/StrategyPicker';
import CandleChart from '../components/CandleChart';

export default function ChartPage() {
  const [params, setParams] = useSearchParams();
  const [stratCode, setStratCode] = useStrategySelection(params.get('strat') ?? 'bnf1');
  const [symbol, setSymbol] = useState(params.get('symbol') ?? '005930.KS');
  const [interval, setInterval] = useState<Interval>('15m');
  const [range, setRange] = useState('60d');
  const [rows, setRows] = useState<StratRow[]>([]);
  const [trades, setTrades] = useState<TradeEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [demo, setDemo] = useState(false);

  const mod = getStrategy(stratCode);

  // 전략 변경 시 권장 봉/기간 적용
  useEffect(() => {
    setInterval(mod.interval);
    setRange(mod.range);
  }, [stratCode, mod.interval, mod.range]);

  const load = async () => {
    setLoading(true);
    try {
      await initStrategy(mod); // 시장 지수 등 외부 데이터 준비 (전략6)
      const { candles, demo: d } = await fetchCandles(symbol, interval, range);
      setDemo(d);
      const ind = mod.compute(candles);
      setRows(ind);
      setTrades(simulate(mod, ind, 10_000_000).trades);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [symbol, interval, range, stratCode]);
  useEffect(() => {
    const s = params.get('symbol');
    if (s && s !== symbol) setSymbol(s);
  }, [params]);

  const last = rows[rows.length - 1];
  const analysis = !loading && rows.length > 1 ? analyzeChart(mod, symbol, stockName(symbol), rows) : null;
  const fmt = (n: number | null | undefined) =>
    n == null ? '-' : n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">차트 분석 — {stockName(symbol)}</h1>
          <p className="text-sm text-slate-400 mt-1">{mod.name}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <StrategyPicker value={stratCode} onChange={(c) => { setStratCode(c); setParams({ symbol, strat: c }); }} />
          <select className="input w-auto" value={symbol} onChange={(e) => { setSymbol(e.target.value); setParams({ symbol: e.target.value, strat: stratCode }); }}>
            {ALL_STOCKS.map((s) => (
              <option key={s.symbol} value={s.symbol}>{s.name} ({s.market})</option>
            ))}
          </select>
          <select className="input w-auto" value={interval} onChange={(e) => {
            const iv = e.target.value as Interval;
            setInterval(iv);
            setRange(RANGE_BY_INTERVAL[iv][RANGE_BY_INTERVAL[iv].length - 1]);
          }}>
            <option value="15m">15분봉</option>
            <option value="60m">60분봉</option>
            <option value="1d">일봉</option>
          </select>
          <select className="input w-auto" value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGE_BY_INTERVAL[interval].map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </header>

      {demo && <span className="badge bg-amber-500/20 text-amber-400">데모 데이터 표시 중 (실시세 조회 실패)</span>}

      {/* 지표 요약 */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <div className="card !p-3">
          <div className="text-xs text-slate-400">종가</div>
          <div className="font-bold text-ink">{fmt(last?.close)}</div>
        </div>
        {mod.lineStyles.slice(0, 4).map((ls) => (
          <div key={ls.key} className="card !p-3">
            <div className="text-xs text-slate-400">{ls.label}</div>
            <div className="font-bold" style={{ color: ls.color }}>{fmt(last?.lines[ls.key])}</div>
          </div>
        ))}
        <div className="card !p-3">
          <div className="text-xs text-slate-400">상태</div>
          <div className="font-bold">
            {last?.buy ? <span className="text-up">🔥 매수신호</span>
              : last?.exit ? <span className="text-amber-400">📉 매도신호</span>
              : <span className="text-slate-400">중립</span>}
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="h-[460px] flex items-center justify-center text-slate-400 animate-pulse">차트 데이터 로딩 중...</div>
        ) : (
          <CandleChart rows={rows} lineStyles={mod.lineStyles} trades={trades} height={460} />
        )}
        <div className="flex gap-4 mt-3 text-xs text-slate-400 flex-wrap">
          {mod.lineStyles.map((ls) => (
            <span key={ls.key}><span style={{ color: ls.color }}>━</span> {ls.label}</span>
          ))}
          <span>▲ 매수 · ● 1차 익절 · ▼ 익절/손절 청산</span>
        </div>
      </div>

      {/* 전략 엔진 분석 (규칙 기반 · AI 미사용) */}
      {analysis && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="font-bold text-ink">📐 전략 엔진 분석 — {mod.name}</h3>
            <span className={`badge ${
              analysis.status === 'BUY' ? 'bg-up/20 text-up'
              : analysis.status === 'SELL' ? 'bg-amber-500/20 text-amber-400'
              : 'bg-edge text-slate-300'
            }`}>{analysis.statusLabel}</span>
          </div>
          <div className="text-sm font-semibold text-accent">{analysis.headline}</div>
          <div className="space-y-2 text-sm text-slate-300 leading-relaxed">
            {analysis.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full max-w-xl">
              <thead>
                <tr className="border-b border-edge">
                  <th className="th">진입 조건</th><th className="th">충족</th><th className="th">배점</th>
                </tr>
              </thead>
              <tbody>
                {analysis.scan.conditions.map((c) => (
                  <tr key={c.label} className="border-b border-edge/50">
                    <td className="td text-slate-300">{c.label}</td>
                    <td className="td">{c.met ? <span className="text-profit">✓ 충족</span> : <span className="text-slate-500">✗ 미충족</span>}</td>
                    <td className="td text-slate-400">{c.pts}점</td>
                  </tr>
                ))}
                <tr>
                  <td className="td font-bold text-ink">합계</td>
                  <td className="td" />
                  <td className="td font-bold text-ink">{analysis.scan.score}점</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-500">※ 본 분석은 AI가 아닌 전략 엔진의 수식 계산 결과를 그대로 서술한 것입니다.</p>
        </div>
      )}
    </div>
  );
}
