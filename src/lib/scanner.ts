// ===== 종목 스캐너: BNF1 조건 충족도 점수(0~100) + 별점(1~5) =====
import type { IndicatorRow, ScanResult } from './types';
import { bwPercentRank } from './indicators';

export function scoreSymbol(symbol: string, name: string, rows: IndicatorRow[]): ScanResult {
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const rank = bwPercentRank(rows);

  const price = last?.close ?? 0;
  const changePct = prev ? ((last.close - prev.close) / prev.close) * 100 : 0;

  const conditions: { label: string; met: boolean; pts: number }[] = [];
  const add = (label: string, met: boolean, pts: number) => conditions.push({ label, met, pts });

  const bwBelowPctile = last?.bandwidth != null && last?.bwPct25 != null && last.bandwidth <= last.bwPct25;
  const bwBelowMa = last?.bandwidth != null && last?.bwMa20 != null && last.bandwidth < last.bwMa20;
  const belowLower = last?.lowerBand != null && last.close < last.lowerBand;
  const nearLower =
    !belowLower && last?.lowerBand != null && last.close <= last.lowerBand * 1.02;
  const volUp = last?.volMa20 != null && last.volume > last.volMa20;
  const rsiOversold = last?.rsi14 != null && last.rsi14 < 35;
  const notExpanding =
    last?.bandwidth != null && prev?.bandwidth != null && last.bandwidth <= prev.bandwidth * 1.1;
  const recentSqueeze = rows.slice(-5).some((r) => r.isSqueezed);

  add('밴드폭 하위 25% (수렴)', bwBelowPctile, 20);
  add('밴드폭 < 밴드폭 MA20', bwBelowMa, 15);
  add('종가 하단밴드 하향 이탈', belowLower, 25);
  add('하단밴드 근접 (2% 이내)', belowLower || nearLower, 5);
  add('거래량 > 20봉 평균', volUp, 10);
  add('RSI(14) < 35 과매도', rsiOversold, 10);
  add('발산(급확장) 아님', notExpanding, 5);
  add('최근 5봉 내 수렴 상태', recentSqueeze, 10);

  const score = conditions.reduce((a, c) => a + (c.met ? c.pts : 0), 0);
  const stars = Math.max(1, Math.min(5, Math.round(score / 20)));

  return {
    symbol,
    name,
    price,
    changePct,
    bandwidth: last?.bandwidth ?? null,
    bwPctRank: rank,
    isSqueezed: last?.isSqueezed ?? false,
    belowLower,
    score,
    stars,
    conditions,
  };
}
