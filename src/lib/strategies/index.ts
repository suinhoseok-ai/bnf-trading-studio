// ===== 전략 레지스트리 =====
import type { StrategyModule } from './types';
import { bnf1 } from './bnf1';
import { breakout } from './breakout';
import { pullback } from './pullback';
import { alignment } from './alignment';
import { box } from './box';
import { rebound } from './rebound';
import { disparity } from './disparity';
import { fetchCandles } from '../marketData';

export * from './types';
export { simulate, manageOpen } from './engine';

/** 코드 → 전략 모듈 */
export const STRATEGIES: Record<string, StrategyModule> = {
  bnf1, breakout, pullback, alignment, box, rebound, disparity,
};

/** 전략 노출 순서 */
export const STRATEGY_ORDER = ['bnf1', 'breakout', 'pullback', 'alignment', 'box', 'rebound', 'disparity'];

/** 클라이언트용 전략 초기화 (시장 지수 등 외부 데이터 준비) — compute 전에 호출 */
export async function initStrategy(mod: StrategyModule): Promise<void> {
  if (mod.init) await mod.init(async (s, i, r) => (await fetchCandles(s, i, r)).candles);
}

export const ALL_STRATEGIES: StrategyModule[] = STRATEGY_ORDER.map((c) => STRATEGIES[c]);

export function getStrategy(code: string): StrategyModule {
  return STRATEGIES[code] ?? bnf1;
}
