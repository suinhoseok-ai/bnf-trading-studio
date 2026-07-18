// ===== 전략선정엔진 라이트 (설계서 08 축약판) =====
// "위험도가 너무 높은 전략은 제외하고, 안전하고 수익을 얻을 수 있는 것으로 추천" (원 요구사항)
// 전체 5요소 점수(신호품질·국면성과 등)는 실거래 데이터 축적 전엔 계산 불가하므로,
// 계산 가능한 3요소로 축약: 국면적합도(regimeFit) + 미세상태 보정 + 패널티.
//
// 컷: "해당 전략 최근 3연속 손실 -15" 패널티는 계정별 데이터가 필요한데 이 화면은
// 사용자 전체에 공통 표시되는 시장 브로드캐스트라 특정 계정 기준으로 계산할 수 없어 생략했다.
// "국면 전환 후 1일차 -10"도 깨끗한 신호가 없어 생략 — 필요해지면 streak==0이 된 첫 회차를
// 별도 플래그로 넘겨 추가할 수 있도록 구조는 열어뒀다.
import { coarseRegime, type Regime, type MicroTag } from './marketRegime';
import type { StrategyModule } from './strategies/types';
import { ALL_STRATEGIES } from './strategies';

const MAX_RISK_FOR_RECOMMEND = 3;
const PRIMARY_MIN_SCORE = 60;
const SECONDARY_MIN_SCORE = 55;
const MICRO_CORRECTION_CAP = 30;

/** 전략 스타일 그룹 — 2순위는 1순위와 다른 그룹에서 뽑는다(같은 성격 중복 추천 방지) */
const STYLE_GROUP: Record<string, string> = {
  breakout: 'breakout', box: 'breakout', openbrk: 'breakout',
  pullback: 'pullback', alignment: 'pullback',
  bnf1: 'reversion', rangeswing: 'reversion',
  rebound: 'bounce', disparity: 'bounce',
};

/** 미세상태 보정 가중치 (설계서 08 §10에서 우리 9전략에 해당하는 태그만 이식). VOLATILITY_SHOCK은 아래 공통 패널티로 별도 처리. */
const MICRO_WEIGHTS: Record<string, Partial<Record<MicroTag, number>>> = {
  breakout: { TREND_ACCELERATION: 20, VOLATILITY_COMPRESSION: 15, OVERHEATED: -15 },
  alignment: { TREND_ACCELERATION: 15, ORDERLY_PULLBACK: 10, OVERHEATED: -10, TREND_BREAKDOWN: -20 },
  pullback: { ORDERLY_PULLBACK: 20, OVERHEATED: -10, TREND_BREAKDOWN: -25 },
  openbrk: { TREND_ACCELERATION: 15, OVERHEATED: -20 },
  bnf1: { RANGE_REVERSION: 20, TREND_ACCELERATION: -25, TREND_BREAKDOWN: -25 },
  rangeswing: { RANGE_REVERSION: 15, TREND_ACCELERATION: -20, TREND_BREAKDOWN: -20 },
  box: { VOLATILITY_COMPRESSION: 15, TREND_ACCELERATION: 10, RANGE_REVERSION: 10, OVERHEATED: -10 },
  rebound: { OVERSOLD_PANIC: 20, TREND_BREAKDOWN: -20 },
  disparity: { OVERSOLD_PANIC: 15, TREND_BREAKDOWN: -15 },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface ScoreEntry {
  code: string;
  name: string;
  regimeFit: number;
  microCorrection: number;
  penalty: number;
  total: number;
  eligible: boolean;   // fit<50 등으로 아예 후보에서 제외됐는지
  reasonCodes: string[];
}

export interface StrategyRecommendation {
  primary: StrategyModule | null;
  secondary: StrategyModule | null;
  cashMode: boolean;        // 추천할 것이 전혀 없음 (대세하락장/전환구간/전체 60점 미만)
  defenseNote?: string;     // BEAR 국면 등 primary가 실제 매수형 전략이 아닌 방어 문구
  scores: ScoreEntry[];     // 전체 후보 점수 구성 (설명가능성 UI용)
  microTags: MicroTag[];
}

function scoreStrategy(m: StrategyModule, coarseKey: Exclude<Regime, 'TRANSITION'>, confidence: number, microTags: MicroTag[]): ScoreEntry {
  const fit = (m.regimeFit as Partial<Record<string, number>>)[coarseKey] ?? 0;
  const reasonCodes: string[] = [];

  let microCorrection = 0;
  const weights = MICRO_WEIGHTS[m.code] ?? {};
  for (const tag of microTags) {
    const w = weights[tag];
    if (w) { microCorrection += w; reasonCodes.push(`${tag}${w > 0 ? '+' : ''}${w}`); }
  }
  microCorrection = clamp(microCorrection, -MICRO_CORRECTION_CAP, MICRO_CORRECTION_CAP);

  let penalty = 0;
  if (m.risk >= 4) { penalty += 15; reasonCodes.push('RISK_HIGH-15'); }
  if (m.risk >= 3 && confidence < 0.55) { penalty += 15; reasonCodes.push('LOW_CONFIDENCE-15'); }
  if (microTags.includes('VOLATILITY_SHOCK')) { penalty += 25; reasonCodes.push('VOLATILITY_SHOCK-25'); }

  const total = clamp(fit + microCorrection - penalty, 0, 100);
  return { code: m.code, name: m.name, regimeFit: fit, microCorrection, penalty, total, eligible: fit >= 50, reasonCodes };
}

/**
 * 확정 국면(6단계) + 신뢰도 + 미세상태 태그로 1·2순위 전략을 선정한다.
 * order: 관리자 지정 순서의 전략코드 배열 (동점 시 우선순위, 없으면 ALL_STRATEGIES 기본 순서)
 */
export function recommendForRegime(regime: Regime, order?: string[], confidence = 1, microTags: MicroTag[] = []): StrategyRecommendation {
  if (regime === 'BEAR_MAJOR') {
    return { primary: null, secondary: null, cashMode: true, defenseNote: '관망·현금화 (신규 롱 금지)', scores: [], microTags };
  }
  if (regime === 'TRANSITION') {
    return { primary: null, secondary: null, cashMode: true, defenseNote: '전환구간 — 기존 포지션 관리, 신규 진입 대기', scores: [], microTags };
  }

  const pool = order && order.length
    ? order.map((code) => ALL_STRATEGIES.find((m) => m.code === code)).filter((m): m is StrategyModule => !!m)
    : ALL_STRATEGIES;
  const eligiblePool = pool.filter((m) => m.risk <= MAX_RISK_FOR_RECOMMEND); // risk 5(openbrk 등)는 항상 제외

  const scores = eligiblePool.map((m) => scoreStrategy(m, regime, confidence, microTags))
    .sort((a, b) => b.total - a.total);

  if (regime === 'BEAR') {
    // 1순위는 항상 리스크오프(방어) — rebound/disparity 중 고득점을 2순위 조건부 허용
    const bounceCandidates = scores.filter((s) => STYLE_GROUP[s.code] === 'bounce' && s.total >= PRIMARY_MIN_SCORE);
    const secondaryEntry = bounceCandidates[0];
    const secondary = secondaryEntry ? eligiblePool.find((m) => m.code === secondaryEntry.code) ?? null : null;
    return { primary: null, secondary, cashMode: false, defenseNote: '리스크오프 (현금 비중 확대)', scores, microTags };
  }

  // BULL_MAJOR / BULL / RANGE
  const top = scores[0];
  if (!top || top.total < PRIMARY_MIN_SCORE) {
    return { primary: null, secondary: null, cashMode: true, scores, microTags };
  }
  const primary = eligiblePool.find((m) => m.code === top.code) ?? null;
  const secondEntry = scores.find((s) => s.code !== top.code && s.total >= SECONDARY_MIN_SCORE && STYLE_GROUP[s.code] !== STYLE_GROUP[top.code])
    ?? scores.find((s) => s.code !== top.code && s.total >= SECONDARY_MIN_SCORE);
  const secondary = secondEntry ? eligiblePool.find((m) => m.code === secondEntry.code) ?? null : null;

  return { primary, secondary, cashMode: false, scores, microTags };
}

export function recommendLine(regime: Regime, order?: string[], confidence = 1, microTags: MicroTag[] = []): string {
  const rec = recommendForRegime(regime, order, confidence, microTags);
  if (rec.cashMode) return rec.defenseNote ?? '추천 가능한 전략이 없습니다 (60점 기준 미달)';
  if (rec.defenseNote && !rec.primary) {
    const sec = rec.secondary ? ` (조건부 2순위: ${rec.secondary.name.split('·')[0].trim()})` : '';
    return `${rec.defenseNote}${sec}`;
  }
  if (!rec.primary) return '추천 가능한 전략이 없습니다';
  const sec = rec.secondary ? ` · 2순위: ${rec.secondary.name.split('·')[0].trim()}` : '';
  return `1순위: ${rec.primary.name.split('·')[0].trim()}${sec}`;
}

export { coarseRegime };
