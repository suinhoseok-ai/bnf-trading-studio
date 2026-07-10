import { useState, useRef, useEffect } from 'react';
import { ollamaChat, ruleBasedAnalysis, ChatMessage, testOllama } from '../lib/ollama';
import { useOllamaConfig } from '../hooks/useOllamaConfig';
import { fetchCandles, KOSPI_STOCKS } from '../lib/marketData';
import { calcIndicators } from '../lib/indicators';
import { scoreSymbol } from '../lib/scanner';

const QUICK_PROMPTS = [
  '오늘 추천 종목 알려줘',
  'BNF 전략을 초보자가 이해하기 쉽게 설명해줘',
  '수렴(Squeeze) 구간이 왜 중요한지 설명해줘',
  '손절가를 본절로 옮기는 이유는?',
];

export default function AIPage() {
  const [config] = useOllamaConfig();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    testOllama(config).then((r) => setConnected(r.ok));
  }, [config]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    const userMsg: ChatMessage = { role: 'user', content: text.trim() };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setBusy(true);

    try {
      // "추천 종목" 질의 시 실시간 스캔 컨텍스트 주입 (AI는 계산하지 않고 해석만)
      let context = '';
      if (/추천|오늘|신호|강한/.test(text)) {
        const scans = [];
        for (const s of KOSPI_STOCKS.slice(0, 6)) {
          try {
            const { candles } = await fetchCandles(s.symbol, '15m', '60d');
            const r = scoreSymbol(s.symbol, s.name, calcIndicators(candles));
            scans.push(`${r.name}: 점수 ${r.score}/100, 밴드폭 하위 ${r.bwPctRank ?? '-'}%, 수렴=${r.isSqueezed ? 'O' : 'X'}, 하단이탈=${r.belowLower ? 'O' : 'X'}, ★${r.stars}`);
          } catch { /* skip */ }
        }
        context = `\n\n[시스템이 방금 계산한 실시간 스캔 결과]\n${scans.join('\n')}`;
      }
      const answer = await ollamaChat(config, [
        ...history.slice(0, -1),
        { role: 'user', content: text.trim() + context },
      ]);
      setMessages([...history, { role: 'assistant', content: answer }]);
    } catch {
      setMessages([
        ...history,
        { role: 'assistant', content: ruleBasedAnalysis('질문: ' + text.trim()) },
      ]);
    }
    setBusy(false);
  };

  return (
    <div className="flex flex-col h-full max-h-[calc(100vh-3rem)] space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">AI 분석 (Qwen3)</h1>
          <p className="text-sm text-slate-400 mt-1">
            로컬 AI 투자 비서 — 계산은 전략 엔진이, 분석·설명·추천은 Qwen3가 담당합니다.
          </p>
        </div>
        <span className={`badge ${connected ? 'bg-profit/20 text-profit' : 'bg-red-500/20 text-red-400'}`}>
          {connected == null ? '연결 확인 중...' : connected ? `● Ollama 연결됨 (${config.model})` : '● Ollama 미연결'}
        </span>
      </header>

      {connected === false && (
        <div className="card bg-amber-500/10 border-amber-500/40 text-sm text-amber-300 leading-relaxed">
          로컬 Ollama에 연결할 수 없습니다. 다음을 확인하세요:
          <ol className="list-decimal ml-5 mt-1 space-y-0.5">
            <li>Ollama 설치 및 모델 다운로드: <code className="bg-base px-1 rounded">ollama pull {config.model}</code></li>
            <li>브라우저 접근 허용 실행: <code className="bg-base px-1 rounded">OLLAMA_ORIGINS=* ollama serve</code> (Windows: <code className="bg-base px-1 rounded">set OLLAMA_ORIGINS=*</code> 후 실행)</li>
            <li>설정 페이지에서 URL(<code className="bg-base px-1 rounded">{config.url}</code>) 확인</li>
          </ol>
          미연결 시에도 규칙 기반 요약으로 응답합니다.
        </div>
      )}

      {/* 대화 영역 */}
      <div className="card flex-1 overflow-y-auto space-y-4 min-h-[300px]">
        {messages.length === 0 && (
          <div className="text-center text-slate-500 py-10">
            <div className="text-3xl mb-2">🤖</div>
            <p className="text-sm">BNF 전략, 종목 분석, 백테스트 결과 등 무엇이든 물어보세요.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
              m.role === 'user' ? 'bg-accent text-white' : 'bg-base border border-edge text-slate-200'
            }`}>
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="bg-base border border-edge rounded-xl px-4 py-3 text-sm text-slate-400 animate-pulse">
              Qwen3가 분석 중입니다...
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 빠른 질문 + 입력 */}
      <div className="space-y-2">
        <div className="flex gap-2 flex-wrap">
          {QUICK_PROMPTS.map((q) => (
            <button key={q} className="btn-ghost !py-1 !px-3 text-xs" onClick={() => send(q)} disabled={busy}>
              {q}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); send(input); }}
        >
          <input
            className="input flex-1"
            placeholder="질문을 입력하세요... (예: 삼성전자 분석해줘)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
          />
          <button className="btn-primary" disabled={busy || !input.trim()}>전송</button>
        </form>
      </div>
    </div>
  );
}
