import { useEffect, useRef } from 'react';
import { createChart, ColorType, UTCTimestamp } from 'lightweight-charts';

export default function EquityChart({ data, height = 220 }: { data: { time: number; value: number }[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || data.length === 0) return;
    const chart = createChart(ref.current, {
      height,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: '#1f2b47' }, horzLines: { color: '#1f2b47' } },
      timeScale: { timeVisible: true, borderColor: '#1f2b47' },
      rightPriceScale: { borderColor: '#1f2b47' },
      autoSize: true,
    });
    const series = chart.addAreaSeries({
      lineColor: '#3b82f6',
      topColor: 'rgba(59,130,246,0.3)',
      bottomColor: 'rgba(59,130,246,0.02)',
      lineWidth: 2,
    });
    // 중복 타임스탬프 제거 (오름차순 보장)
    const seen = new Set<number>();
    const clean = data.filter((d) => (seen.has(d.time) ? false : (seen.add(d.time), true)));
    series.setData(clean.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data, height]);

  return <div ref={ref} className="w-full" style={{ height }} />;
}
