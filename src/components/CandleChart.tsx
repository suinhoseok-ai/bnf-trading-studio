import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  IChartApi,
  UTCTimestamp,
  SeriesMarker,
  Time,
} from 'lightweight-charts';
import type { IndicatorRow, TradeEvent } from '../lib/types';

interface Props {
  rows: IndicatorRow[];
  trades?: TradeEvent[];
  height?: number;
}

/** TradingView Lightweight Charts: 캔들 + MA20 + 상/하단 밴드 + 매매 마커 */
export default function CandleChart({ rows, trades = [], height = 460 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: '#1f2b47' },
        horzLines: { color: '#1f2b47' },
      },
      timeScale: { timeVisible: true, borderColor: '#1f2b47' },
      rightPriceScale: { borderColor: '#1f2b47' },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    chartRef.current = chart;

    const candles = chart.addCandlestickSeries({
      upColor: '#ef4444',
      downColor: '#3b82f6',
      wickUpColor: '#ef4444',
      wickDownColor: '#3b82f6',
      borderVisible: false,
    });
    candles.setData(
      rows.map((r) => ({
        time: r.time as UTCTimestamp,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
      })),
    );

    const lineOpts = { lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    const ma = chart.addLineSeries({ color: '#f59e0b', ...lineOpts, lineWidth: 2 });
    const ub = chart.addLineSeries({ color: '#22c55e', ...lineOpts });
    const lb = chart.addLineSeries({ color: '#22c55e', ...lineOpts });

    const toLine = (key: 'ma20' | 'upperBand' | 'lowerBand') =>
      rows
        .filter((r) => r[key] != null)
        .map((r) => ({ time: r.time as UTCTimestamp, value: r[key] as number }));
    ma.setData(toLine('ma20'));
    ub.setData(toLine('upperBand'));
    lb.setData(toLine('lowerBand'));

    // 수렴(Squeeze) 구간 배경 마커 + 매매 마커
    const markers: SeriesMarker<Time>[] = [];
    for (const t of trades) {
      if (t.type === 'BUY') {
        markers.push({ time: t.time as UTCTimestamp, position: 'belowBar', color: '#ef4444', shape: 'arrowUp', text: '매수' });
      } else if (t.type === 'TP1') {
        markers.push({ time: t.time as UTCTimestamp, position: 'aboveBar', color: '#22c55e', shape: 'circle', text: '익절50%' });
      } else if (t.type === 'TP2') {
        markers.push({ time: t.time as UTCTimestamp, position: 'aboveBar', color: '#22c55e', shape: 'arrowDown', text: '전량익절' });
      } else if (t.type === 'SL') {
        markers.push({ time: t.time as UTCTimestamp, position: 'aboveBar', color: '#f97316', shape: 'arrowDown', text: '손절' });
      }
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    candles.setMarkers(markers);

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [rows, trades, height]);

  return <div ref={containerRef} className="w-full" style={{ height }} />;
}
