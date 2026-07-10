import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchCandles, ALL_STOCKS, RANGE_BY_INTERVAL, Interval, stockName } from '../lib/marketData';
import { calcIndicators, bwPercentRank } from '../lib/indicators';
import { runBacktest } from '../lib/simulator';
import type { IndicatorRow, TradeEvent } from '../lib/types';
import CandleChart from '../components/CandleChart';

export default function ChartPage() {
  const [params, setParams] = useSearchParams();
  const [symbol, setSymbol] = useState(params.get('symbol') ?? '005930.KS');
  const [interval, setInterval] = useState<Interval>('15m');
  const [range, setRange] = useState('60d');
  const [rows, setRows] = useState<IndicatorRow[]>([]);
  const [trades, setTrades] = useState<TradeEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [demo, setDemo] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { candles, demo: d } = await fetchCandles(symbol, interval, range);
      setDemo(d);
      const ind = calcIndicators(candles);
      setRows(ind);
      // 화면 구간에 대한 시뮬레이션으로 매매 마커 생성
      const result = runBacktest(ind);
      setTrades(result.trades);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [symbol, interval, range]);
  useEffect(() => {
    const s = params.get('symbol');
    if (s && s !== symbol) setSymbol(s);
  }, [params]);

  const last = rows[rows.length - 1];
  const rank = bwPercentRank(rows);
  const fmt = (n: number | null | undefined) =>
    n == null ? '-' : n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">차트 분석 — {stockName(symbol)}</h1>
          <p className="text-sm text-slate-400 mt-1">볼린저밴드(20, 2σ) + BNF1 매매 시그널 마커</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select className="input w-auto" value={symbol} onChange={(e) => { setSymbol(e.target.value); setParams({ symbol: e.target.value }); }}>
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
          <div className="font-bold text-white">{fmt(last?.close)}</div>
        </div>
        <div className="card !p-3">
          <div className="text-xs text-slate-400">MA20 (중심선)</div>
          <div className="font-bold text-amber-400">{fmt(last?.ma20)}</div>
        </div>
        <div className="card !p-3">
          <div className="text-xs text-slate-400">상단밴드</div>
          <div className="font-bold text-profit">{fmt(last?.upperBand)}</div>
        </div>
        <div className="card !p-3">
          <div className="text-xs text-slate-400">하단밴드</div>
          <div className="font-bold text-profit">{fmt(last?.lowerBand)}</div>
        </div>
        <div className="card !p-3">
          <div className="text-xs text-slate-400">밴드폭 (BW)</div>
          <div className="font-bold text-white">{last?.bandwidth != null ? (last.bandwidth * 100).toFixed(2) + '%' : '-'}</div>
          <div className="text-xs text-slate-500">{rank != null ? `100봉 중 하위 ${rank}%` : ''}</div>
        </div>
        <div className="card !p-3">
          <div className="text-xs text-slate-400">상태</div>
          <div className="font-bold">
            {last?.buySignal ? <span className="text-up">🔥 매수신호</span>
              : last?.isSqueezed ? <span className="text-accent">수렴 중</span>
              : <span className="text-slate-400">중립</span>}
          </div>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <div className="h-[460px] flex items-center justify-center text-slate-400 animate-pulse">차트 데이터 로딩 중...</div>
        ) : (
          <CandleChart rows={rows} trades={trades} height={460} />
        )}
        <div className="flex gap-4 mt-3 text-xs text-slate-400">
          <span><span className="text-amber-400">━</span> MA20 중심선</span>
          <span><span className="text-profit">━</span> 상/하단 밴드 (±2σ)</span>
          <span>▲ 매수 · ● 1차 익절 50% · ▼ 2차 익절/손절</span>
        </div>
      </div>
    </div>
  );
}
