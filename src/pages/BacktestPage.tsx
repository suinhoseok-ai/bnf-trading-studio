import { useEffect, useState } from 'react';
import { fetchCandles, ALL_STOCKS, RANGE_BY_INTERVAL, Interval, stockName } from '../lib/marketData';
import { getStrategy, simulate, initStrategy } from '../lib/strategies';
import type { BacktestResult } from '../lib/types';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { ollamaChat, ruleBasedAnalysis } from '../lib/ollama';
import { useOllamaConfig } from '../hooks/useOllamaConfig';
import { useStrategySelection } from '../hooks/useStrategySelection';
import StrategyPicker from '../components/StrategyPicker';
import EquityChart from '../components/EquityChart';

interface SavedResult {
  id: number;
  symbol: string;
  name: string;
  strategy_code?: string;
  interval: string;
  range_label: string;
  metrics: Record<string, number>;
  created_at: string;
}

export default function BacktestPage() {
  const { profile, guestMode, allowedStrategyCodes } = useAuth();
  const [stratCode, setStratCode] = useStrategySelection();
  const [symbol, setSymbol] = useState('005930.KS');
  const [interval, setInterval] = useState<Interval>('1d');
  const [range, setRange] = useState('2y');
  const [initialBalance, setInitialBalance] = useState(10_000_000);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [demo, setDemo] = useState(false);
  const [saved, setSaved] = useState<SavedResult[]>([]);
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [ollamaConfig] = useOllamaConfig();

  const mod = getStrategy(stratCode);
  const enabled = allowedStrategyCodes.includes(stratCode);

  // 전략 변경 시 권장 봉/기간으로 자동 설정
  useEffect(() => {
    setInterval(mod.interval);
    setRange(mod.range);
  }, [stratCode, mod.interval, mod.range]);

  const loadSaved = async () => {
    if (guestMode || !profile) return;
    const { data } = await supabase
      .from('bnf_backtest_results')
      .select('*')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(20);
    setSaved((data as unknown as SavedResult[]) ?? []);
  };
  useEffect(() => { loadSaved(); }, []);

  const run = async () => {
    if (!enabled) return;
    setRunning(true);
    setResult(null);
    setAiText('');
    try {
      await initStrategy(mod); // 시장 지수 등 준비 (전략6)
      const { candles, demo: d } = await fetchCandles(symbol, interval, range);
      setDemo(d);
      const rows = mod.compute(candles);
      const res = simulate(mod, rows, initialBalance);
      setResult(res);

      if (!guestMode && profile) {
        await supabase.from('bnf_backtest_results').insert({
          user_id: profile.id,
          symbol,
          name: stockName(symbol),
          strategy_code: stratCode,
          interval,
          range_label: range,
          initial_balance: initialBalance,
          metrics: res.metrics as unknown as Record<string, number>,
        });
        await loadSaved();
      }
    } finally {
      setRunning(false);
    }
  };

  const analyzeAI = async () => {
    if (!result) return;
    setAiBusy(true);
    const m = result.metrics;
    const context = [
      `전략: ${mod.name}`,
      `백테스트 대상: ${stockName(symbol)} (${symbol}) · ${interval} 봉 · 기간 ${range}`,
      `총수익률: ${m.totalReturn.toFixed(2)}% · 승률: ${m.winRate.toFixed(1)}%`,
      `MDD: ${m.mdd.toFixed(2)}% · Profit Factor: ${m.profitFactor.toFixed(2)} (권장 1.5 이상)`,
      `Sharpe: ${m.sharpe.toFixed(2)} · CAGR: ${m.cagr.toFixed(2)}%`,
      `거래횟수: ${m.tradeCount}회 · 평균보유: ${m.avgHoldBars.toFixed(1)}봉`,
      `최종자산: ${m.finalBalance.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}원 (초기 ${m.initialBalance.toLocaleString('ko-KR')}원)`,
    ].join('\n');
    try {
      const answer = await ollamaChat(ollamaConfig, [
        { role: 'user', content: `다음 백테스트 결과를 평가해줘. 손익비/승률/MDD 관점에서 어떤지, 왜 그런 결과가 나왔을지, 개선 방안은 무엇인지 분석해줘.\n\n${context}` },
      ]);
      setAiText(answer);
    } catch {
      setAiText(ruleBasedAnalysis(context));
    }
    setAiBusy(false);
  };

  const fmt = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
  const m = result?.metrics;

  const metricCards = m
    ? [
        { label: '총수익률', value: `${m.totalReturn.toFixed(2)}%`, color: m.totalReturn >= 0 ? 'text-up' : 'text-down' },
        { label: '승률', value: `${m.winRate.toFixed(1)}%`, color: m.winRate >= 50 ? 'text-profit' : 'text-amber-400' },
        { label: 'MDD', value: `${m.mdd.toFixed(2)}%`, color: 'text-amber-400' },
        { label: 'Profit Factor', value: m.profitFactor >= 999 ? '∞' : m.profitFactor.toFixed(2), color: m.profitFactor >= 1.5 ? 'text-profit' : 'text-amber-400' },
        { label: 'Sharpe Ratio', value: m.sharpe.toFixed(2), color: 'text-ink' },
        { label: '연평균수익률', value: `${m.cagr.toFixed(2)}%`, color: 'text-ink' },
        { label: '거래횟수', value: `${m.tradeCount}회`, color: 'text-ink' },
        { label: '평균보유기간', value: `${m.avgHoldBars.toFixed(1)}봉`, color: 'text-ink' },
      ]
    : [];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">백테스트</h1>
        <p className="text-sm text-slate-400 mt-1">{mod.short}</p>
      </header>

      {/* 실행 조건 */}
      <div className="card flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs text-slate-400 block mb-1">전략</label>
          <StrategyPicker value={stratCode} onChange={setStratCode} />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">종목</label>
          <select className="input w-auto" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {ALL_STOCKS.map((s) => <option key={s.symbol} value={s.symbol}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">봉 주기</label>
          <select className="input w-auto" value={interval} onChange={(e) => {
            const iv = e.target.value as Interval;
            setInterval(iv);
            setRange(RANGE_BY_INTERVAL[iv][RANGE_BY_INTERVAL[iv].length - 1]);
          }}>
            <option value="15m">15분봉 (최대 60일)</option>
            <option value="60m">60분봉 (최대 2년)</option>
            <option value="1d">일봉 (최대 전체)</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">기간</label>
          <select className="input w-auto" value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGE_BY_INTERVAL[interval].map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">초기 자본금 (원)</label>
          <input className="input w-40" type="number" value={initialBalance} step={1_000_000} onChange={(e) => setInitialBalance(Number(e.target.value))} />
        </div>
        <button className="btn-primary" onClick={run} disabled={running || !enabled}>
          {running ? '시뮬레이션 중...' : '백테스트 실행'}
        </button>
        {demo && result && <span className="badge bg-amber-500/20 text-amber-400">데모 데이터 기반</span>}
      </div>

      {!enabled && (
        <div className="card bg-red-500/10 border-red-500/40 text-red-300 text-sm">해당 전략 사용 권한이 없습니다.</div>
      )}

      {result && m && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {metricCards.map((c) => (
              <div key={c.label} className="card !p-3">
                <div className="text-xs text-slate-400">{c.label}</div>
                <div className={`text-lg font-bold ${c.color}`}>{c.value}</div>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-bold text-ink">자산 곡선 (Equity Curve)</h3>
              <div className="text-sm text-slate-400">
                최종자산 <span className="text-ink font-bold">{fmt(m.finalBalance)}원</span>
              </div>
            </div>
            <EquityChart data={result.equityCurve} />
          </div>

          <div className="card border-purple-500/40">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-bold text-purple-300">🤖 Qwen3 백테스트 분석</h3>
              <button className="btn-ghost" onClick={analyzeAI} disabled={aiBusy}>
                {aiBusy ? '분석 중...' : 'AI 분석 실행'}
              </button>
            </div>
            {aiText && <pre className="text-sm text-slate-200 whitespace-pre-wrap font-sans leading-relaxed">{aiText}</pre>}
          </div>

          <div className="card">
            <h3 className="font-bold text-ink mb-2">거래 로그 ({result.trades.length}건)</h3>
            <div className="max-h-72 overflow-y-auto text-sm space-y-1">
              {result.logs.map((log, i) => (
                <div key={i} className={`px-3 py-1.5 rounded ${
                  log.includes('[매수]') ? 'bg-up/10 text-up'
                  : log.includes('익절') ? 'bg-profit/10 text-profit'
                  : 'bg-amber-500/10 text-amber-400'
                }`}>{log}</div>
              ))}
              {result.logs.length === 0 && <div className="text-slate-500 py-4 text-center">해당 기간에 발생한 매매 신호가 없습니다.</div>}
            </div>
          </div>
        </>
      )}

      {/* 저장된 결과 */}
      {!guestMode && saved.length > 0 && (
        <div className="card overflow-x-auto">
          <h3 className="font-bold text-ink mb-2">저장된 백테스트 이력</h3>
          <table className="w-full">
            <thead>
              <tr className="border-b border-edge">
                <th className="th">일시</th><th className="th">전략</th><th className="th">종목</th><th className="th">주기</th><th className="th">기간</th>
                <th className="th">총수익률</th><th className="th">승률</th><th className="th">MDD</th><th className="th">PF</th><th className="th">거래</th>
              </tr>
            </thead>
            <tbody>
              {saved.map((s) => (
                <tr key={s.id} className="border-b border-edge/50">
                  <td className="td text-slate-400">{new Date(s.created_at).toLocaleString('ko-KR')}</td>
                  <td className="td text-slate-300">{getStrategy(s.strategy_code ?? 'bnf1').name.split('·')[0].trim()}</td>
                  <td className="td text-ink">{s.name || s.symbol}</td>
                  <td className="td">{s.interval}</td>
                  <td className="td">{s.range_label}</td>
                  <td className={`td font-bold ${(s.metrics.totalReturn ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>{(s.metrics.totalReturn ?? 0).toFixed(2)}%</td>
                  <td className="td">{(s.metrics.winRate ?? 0).toFixed(1)}%</td>
                  <td className="td">{(s.metrics.mdd ?? 0).toFixed(2)}%</td>
                  <td className="td">{(s.metrics.profitFactor ?? 0).toFixed(2)}</td>
                  <td className="td">{s.metrics.tradeCount ?? 0}회</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
