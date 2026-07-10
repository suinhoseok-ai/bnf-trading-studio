import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  IChartApi,
  UTCTimestamp,
  SeriesMarker,
  Time,
} from 'lightweight-charts';
import type { TradeEvent } from '../lib/types';
import type { StratRow, LineStyle } from '../lib/strategies/types';

interface Props {
  rows: StratRow[];
  lineStyles: LineStyle[];
  trades?: TradeEvent[];
  height?: number;
}

/** TradingView Lightweight Charts: 캔들 + 전략별 오버레이 라인 + 매매 마커 */
export default function CandleChart({ rows, lineStyles, trades = [], height = 460 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      height,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: '#1f2b47' }, horzLines: { color: '#1f2b47' } },
      timeScale: { timeVisible: true, borderColor: '#1f2b47' },
      rightPriceScale: { borderColor: '#1f2b47' },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    chartRef.current = chart;

    const candles = chart.addCandlestickSeries({
      upColor: '#ef4444', downColor: '#3b82f6',
      wickUpColor: '#ef4444', wickDownColor: '#3b82f6',
      borderVisible: false,
    });
    candles.setData(
      rows.map((r) => ({ time: r.time as UTCTimestamp, open: r.open, high: r.high, low: r.low, close: r.close })),
    );

    const baseOpts = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const;
    for (const ls of lineStyles) {
      const series = chart.addLineSeries({ color: ls.color, lineWidth: (ls.width ?? 1) as 1 | 2 | 3, ...baseOpts });
      series.setData(
        rows
          .filter((r) => r.lines[ls.key] != null)
          .map((r) => ({ time: r.time as UTCTimestamp, value: r.lines[ls.key] as number })),
      );
    }

    const markers: SeriesMarker<Time>[] = [];
    for (const t of trades) {
      if (t.type === 'BUY') markers.push({ time: t.time as UTCTimestamp, position: 'belowBar', color: '#ef4444', shape: 'arrowUp', text: '매수' });
      else if (t.type === 'TP1') markers.push({ time: t.time as UTCTimestamp, position: 'aboveBar', color: '#22c55e', shape: 'circle', text: '익절50%' });
      else if (t.type === 'TP2') markers.push({ time: t.time as UTCTimestamp, position: 'aboveBar', color: '#22c55e', shape: 'arrowDown', text: '전량익절' });
      else if (t.type === 'SL') markers.push({ time: t.time as UTCTimestamp, position: 'aboveBar', color: '#f97316', shape: 'arrowDown', text: '손절' });
      else if (t.type === 'EOD') markers.push({ time: t.time as UTCTimestamp, position: 'aboveBar', color: '#94a3b8', shape: 'square', text: '평가' });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    candles.setMarkers(markers);

    chart.timeScale().fitContent();
    return () => { chart.remove(); chartRef.current = null; };
  }, [rows, lineStyles, trades, height]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
