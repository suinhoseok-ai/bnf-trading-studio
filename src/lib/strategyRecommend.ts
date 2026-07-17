// ===== 국면별 추천 전략 (라이트) =====
// "위험도가 너무 높은 전략은 제외하고, 안전하고 수익을 얻을 수 있는 것으로 추천" (원 요구사항)
// → 현재 확정 국면(6국면)을 전략 메타의 3분류(coarse)로 사상해, 일치하고 risk<=3인 전략 중
//   관리자 지정 순서(STRATEGY_ORDER) 상위 2개를 1·2순위로 추천.
// 대세하락장/전환구간은 신규 롱 금지 → CASH_MODE(추천 없음).
// (전략선정엔진 풀버전 — 미세상태·점수식 — 은 Phase C에서 확장 예정)
import { coarseRegime, type Regime } from './marketRegime';
import type { StrategyModule } from './strategies/types';
import { ALL_STRATEGIES } from './strategies';

const MAX_RISK_FOR_RECOMMEND = 3;

export interface StrategyRecommendation {
  primary: StrategyModule | null;
  secondary: StrategyModule | null;
  cashMode: boolean;   // 신규 롱 금지 국면 (대세하락/전환구간)
}

/** order: 관리자 지정 순서의 전략코드 배열 (없으면 ALL_STRATEGIES 기본 순서) */
export function recommendForRegime(regime: Regime, order?: string[]): StrategyRecommendation {
  if (regime === 'BEAR_MAJOR' || regime === 'TRANSITION') {
    return { primary: null, secondary: null, cashMode: true };
  }
  const coarse = coarseRegime(regime);
  const pool = order && order.length
    ? order.map((code) => ALL_STRATEGIES.find((m) => m.code === code)).filter((m): m is StrategyModule => !!m)
    : ALL_STRATEGIES;

  const candidates = pool.filter((m) => (m.regime === coarse || m.regime === 'ANY') && m.risk <= MAX_RISK_FOR_RECOMMEND);
  return { primary: candidates[0] ?? null, secondary: candidates[1] ?? null, cashMode: false };
}

export function recommendLine(regime: Regime, order?: string[]): string {
  const { primary, secondary, cashMode } = recommendForRegime(regime, order);
  if (cashMode) return regime === 'BEAR_MAJOR' ? '관망·현금화 (신규 롱 금지)' : '전환구간 — 기존 포지션 관리, 신규 진입 대기';
  if (!primary) return '추천 가능한 전략이 없습니다 (위험도 기준 충족 전략 없음)';
  const cash = regime === 'BEAR' ? ' · 현금 비중 확대 권고' : '';
  const sec = secondary ? ` (차선: ${secondary.name.split('·')[0].trim()})` : '';
  return `추천: ${primary.name.split('·')[0].trim()}${sec}${cash}`;
}
