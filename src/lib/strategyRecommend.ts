// ===== 국면별 추천 전략 =====
// "위험도가 너무 높은 전략은 제외하고, 안전하고 수익을 얻을 수 있는 것으로 추천" (원 요구사항)
// → 현재 국면과 전략의 regime이 일치하고 risk<=3인 전략 중, 관리자 지정 순서(STRATEGY_ORDER) 상위 2개.
import type { Regime } from './marketRegime';
import type { StrategyModule } from './strategies/types';
import { ALL_STRATEGIES } from './strategies';

const MAX_RISK_FOR_RECOMMEND = 3;

export interface StrategyRecommendation {
  primary: StrategyModule | null;
  secondary: StrategyModule | null;
}

/** order: 관리자 지정 순서의 전략코드 배열 (없으면 ALL_STRATEGIES 기본 순서) */
export function recommendForRegime(regime: Regime, order?: string[]): StrategyRecommendation {
  const pool = order && order.length
    ? order.map((code) => ALL_STRATEGIES.find((m) => m.code === code)).filter((m): m is StrategyModule => !!m)
    : ALL_STRATEGIES;

  const candidates = pool.filter((m) => (m.regime === regime || m.regime === 'ANY') && m.risk <= MAX_RISK_FOR_RECOMMEND);
  return { primary: candidates[0] ?? null, secondary: candidates[1] ?? null };
}

export function recommendLine(regime: Regime, order?: string[]): string {
  const { primary, secondary } = recommendForRegime(regime, order);
  if (!primary) return '추천 가능한 전략이 없습니다 (위험도 기준 충족 전략 없음)';
  const cash = regime === 'BEAR' ? ' · 현금 비중 확대 권고' : '';
  const sec = secondary ? ` (차선: ${secondary.name.split('·')[0].trim()})` : '';
  return `추천: ${primary.name.split('·')[0].trim()}${sec}${cash}`;
}
