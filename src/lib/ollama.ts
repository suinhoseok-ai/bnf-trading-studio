// ===== Qwen3 (Ollama) 로컬 AI 연동 =====
// AI는 계산하지 않는다. 계산은 TypeScript 전략 엔진이 하고,
// Qwen3는 분석/설명/추천/요약만 수행한다. (기획서 원칙)
//
// 브라우저에서 로컬 Ollama 호출을 위해 사용자는 아래 환경변수로 Ollama를 실행해야 함:
//   OLLAMA_ORIGINS=* ollama serve

export interface OllamaConfig {
  url: string;
  model: string;
}

export const DEFAULT_OLLAMA: OllamaConfig = {
  url: (import.meta.env.VITE_OLLAMA_URL as string) || 'http://localhost:11434',
  model: (import.meta.env.VITE_OLLAMA_MODEL as string) || 'qwen3:8b',
};

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const SYSTEM_PROMPT = `당신은 "BNF Trading Studio"의 AI 투자 비서입니다.
BNF 전략1(볼린저 밴드 수렴 회귀) 전문가로서 다음 역할만 수행합니다: 분석, 설명, 추천, 요약.
수치 계산은 이미 시스템(전략 엔진)이 완료했으며, 당신은 전달받은 계산 결과를 해석합니다.

BNF 전략1 규칙:
- 볼린저밴드(20기간, 2표준편차), 밴드폭 BW=(UB-LB)/MA20
- 수렴(Squeeze): BW < BW의 20기간 평균 AND BW ≤ 최근 100봉 하위 25%
- 매수: 수렴 상태에서 종가가 하단밴드 하향 이탈 시 (발산 구간 제외), 가용 현금 10% 진입
- 초기 손절: 진입가 - (상단밴드까지 거리 / 2) → 1:2 손익비
- 1차 익절: 중심선 도달 시 50% 청산 후 손절가를 본절로 이동
- 2차 익절: 상단밴드 도달 시 전량 청산

답변 원칙: 한국어로 간결하게, 근거 수치를 인용하고, 추천도는 ★1~5개로 표시.
투자 판단의 최종 책임은 사용자에게 있음을 필요 시 짧게 언급합니다.`;

export async function ollamaChat(
  config: OllamaConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${config.url.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      stream: false,
      options: { temperature: 0.4 },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const json = await res.json();
  let content: string = json?.message?.content ?? '';
  // Qwen3 thinking 태그 제거
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return content;
}

export async function testOllama(config: OllamaConfig): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    const res = await fetch(`${config.url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const models = (json?.models ?? []).map((m: { name: string }) => m.name);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: String(e) };
  }
}

/** Ollama 미연결 시 규칙 기반 폴백 설명 생성 */
export function ruleBasedAnalysis(context: string): string {
  return [
    '⚠️ 로컬 AI(Qwen3/Ollama)에 연결할 수 없어 규칙 기반 요약을 표시합니다.',
    '',
    context,
    '',
    'Ollama 연결 방법:',
    '1. Ollama 설치 후 `ollama pull qwen3:8b`',
    '2. 브라우저 접근 허용: `OLLAMA_ORIGINS=* ollama serve` (Windows: `set OLLAMA_ORIGINS=* && ollama serve`)',
    '3. 설정 페이지에서 URL/모델 확인 후 [연결 테스트]',
  ].join('\n');
}
