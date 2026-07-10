// ===== 규칙 기반 차트 분석 (AI 미사용) =====
// 전략 엔진이 계산한 지표·신호를 바탕으로 사람이 읽을 수 있는 분석문을 생성한다.
import type { StrategyModule, StratRow, StratScan } from './strategies/types';

export interface ChartAnalysis {
  status: 'BUY' | 'SELL' | 'NEUTRAL';
  statusLabel: string;
  headline: string;
  paragraphs: string[];
  scan: StratScan;
}

const fmt = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
const fmtTime = (unix: number) => {
  const d = new Date(unix * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function analyzeChart(mod: StrategyModule, symbol: string, name: string, rows: StratRow[]): ChartAnalysis | null {
  if (rows.length < 2) return null;
  const last = rows[rows.length - 1];
  const scan = mod.scan(symbol, name, rows);
  const stratShort = mod.name.split('·')[0].trim();

  const status: ChartAnalysis['status'] = scan.buy ? 'BUY' : scan.exit ? 'SELL' : 'NEUTRAL';
  const statusLabel = status === 'BUY' ? '🔥 매수 신호' : status === 'SELL' ? '📉 매도(청산) 신호' : '⚪ 중립';

  const paragraphs: string[] = [];

  // 1) 현재 상태 요약
  paragraphs.push(
    `${name}의 현재가는 ${fmt(scan.price)}원(전봉 대비 ${scan.changePct >= 0 ? '+' : ''}${scan.changePct.toFixed(2)}%)이며, ` +
    `${stratShort} 기준 조건 충족 점수는 100점 만점에 ${scan.score}점(추천도 ${'★'.repeat(scan.stars)}${'☆'.repeat(5 - scan.stars)})입니다.`,
  );

  // 2) 주요 레벨 대비 위치
  const levelParts: string[] = [];
  for (const ls of mod.lineStyles) {
    const v = last.lines[ls.key];
    if (v == null || v === 0) continue;
    const diff = ((last.close - v) / v) * 100;
    levelParts.push(`${ls.label} ${fmt(v)}원 (종가 대비 ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%)`);
  }
  if (levelParts.length) paragraphs.push(`주요 레벨: ${levelParts.join(' · ')}.`);

  // 3) 조건 충족/미충족 해설
  const met = scan.conditions.filter((c) => c.met);
  const unmet = scan.conditions.filter((c) => !c.met);
  if (met.length) paragraphs.push(`충족된 조건 (${met.length}/${scan.conditions.length}): ${met.map((c) => c.label).join(', ')}.`);
  if (unmet.length) paragraphs.push(`미충족 조건: ${unmet.map((c) => c.label).join(', ')}.`);

  // 4) 상태별 해석 및 대응
  if (status === 'BUY') {
    const plan = mod.planEntry(rows, rows.length - 1, 10_000_000);
    if (plan) {
      const slTxt = plan.sl > 0 ? `초기 손절가는 ${fmt(plan.sl)}원(진입가 대비 ${(((plan.sl - plan.entry_price) / plan.entry_price) * 100).toFixed(2)}%)으로 설정됩니다` : '이 전략은 가격 손절 대신 시간 청산을 사용합니다';
      paragraphs.push(
        `현재 봉에서 ${stratShort} 매수 조건이 모두 충족되어 매수 신호가 발생했습니다. ` +
        `전략 규칙상 가용 현금의 ${mod.positionPct}%를 ${fmt(plan.entry_price)}원 부근에서 진입하며, ${slTxt}. (${plan.note})`,
      );
    }
  } else if (status === 'SELL') {
    paragraphs.push(
      `현재 봉에서 ${stratShort}의 청산(매도) 조건이 충족된 상태입니다. ` +
      `이 전략으로 보유 중인 포지션이 있다면 규칙에 따라 익절/청산을 검토할 시점입니다. 신규 진입은 권장되지 않습니다.`,
    );
  } else {
    const key = unmet.sort((a, b) => b.pts - a.pts)[0];
    paragraphs.push(
      `현재는 매수·매도 어느 쪽 신호도 발생하지 않은 중립 구간입니다.` +
      (key ? ` 매수 신호까지 가장 큰 미충족 조건은 "${key.label}"(배점 ${key.pts}점)입니다.` : ''),
    );
  }

  // 5) 최근 신호 이력
  let lastBuyIdx = -1, lastExitIdx = -1;
  for (let i = rows.length - 1; i >= 0 && (lastBuyIdx < 0 || lastExitIdx < 0); i--) {
    if (lastBuyIdx < 0 && rows[i].buy) lastBuyIdx = i;
    if (lastExitIdx < 0 && rows[i].exit) lastExitIdx = i;
  }
  const hist: string[] = [];
  if (lastBuyIdx >= 0) hist.push(`마지막 매수 신호는 ${fmtTime(rows[lastBuyIdx].time)} 봉(${rows.length - 1 - lastBuyIdx}봉 전, ${fmt(rows[lastBuyIdx].close)}원)`);
  if (lastExitIdx >= 0) hist.push(`마지막 매도 신호는 ${fmtTime(rows[lastExitIdx].time)} 봉(${rows.length - 1 - lastExitIdx}봉 전, ${fmt(rows[lastExitIdx].close)}원)`);
  if (hist.length) paragraphs.push(`${hist.join(', ')}에 발생했습니다.`);
  else paragraphs.push('조회 구간 내 발생한 매매 신호가 없습니다.');

  const headline =
    status === 'BUY' ? `${stratShort} 매수 조건 충족 — 진입 검토 구간`
    : status === 'SELL' ? `${stratShort} 청산 조건 충족 — 보유 시 매도 검토`
    : `${stratShort} 기준 관망 구간 (점수 ${scan.score}점)`;

  return { status, statusLabel, headline, paragraphs, scan };
}
