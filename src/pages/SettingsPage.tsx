import { useState } from 'react';
import { useOllamaConfig } from '../hooks/useOllamaConfig';
import { testOllama } from '../lib/ollama';
import { useAuth } from '../context/AuthContext';

export default function SettingsPage() {
  const { profile, guestMode } = useAuth();
  const [config, saveConfig] = useOllamaConfig();
  const [url, setUrl] = useState(config.url);
  const [model, setModel] = useState(config.model);
  const [testResult, setTestResult] = useState<{ ok: boolean; models: string[]; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    const r = await testOllama({ url, model });
    setTestResult(r);
    setTesting(false);
  };

  const save = async () => {
    await saveConfig({ url: url.trim(), model: model.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <header>
        <h1 className="text-2xl font-bold text-white">설정</h1>
        <p className="text-sm text-slate-400 mt-1">사용자별 로컬 AI(Qwen3/Ollama) 연동 설정 — {guestMode ? '게스트: 브라우저에 저장' : '계정에 저장됩니다'}</p>
      </header>

      <div className="card space-y-4">
        <h2 className="font-bold text-white">🤖 Qwen3 (Ollama) 연결</h2>
        <div>
          <label className="text-xs text-slate-400 block mb-1">Ollama URL</label>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:11434" />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">모델명</label>
          <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="qwen3:8b" />
          <p className="text-xs text-slate-500 mt-1">예: qwen3:8b, qwen3:14b, qwen3:32b — 먼저 <code className="bg-base px-1 rounded">ollama pull 모델명</code> 실행 필요</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={runTest} disabled={testing}>{testing ? '테스트 중...' : '연결 테스트'}</button>
          <button className="btn-primary" onClick={save}>{saved ? '✓ 저장됨' : '저장'}</button>
        </div>
        {testResult && (
          <div className={`text-sm rounded-lg p-3 ${testResult.ok ? 'bg-profit/10 text-profit' : 'bg-red-500/10 text-red-400'}`}>
            {testResult.ok ? (
              <>
                ✓ 연결 성공! 설치된 모델: {testResult.models.length > 0 ? testResult.models.join(', ') : '(없음 — ollama pull 필요)'}
                {testResult.models.length > 0 && !testResult.models.some((m) => m.startsWith(model.split(':')[0])) && (
                  <div className="text-amber-400 mt-1">⚠ 입력한 모델({model})이 설치 목록에 없습니다.</div>
                )}
              </>
            ) : (
              <>
                ✗ 연결 실패: {testResult.error}
                <div className="text-slate-400 mt-2 leading-relaxed">
                  브라우저에서 로컬 Ollama에 접근하려면 CORS 허용이 필요합니다:<br />
                  <code className="bg-base px-1 rounded">Windows: set OLLAMA_ORIGINS=* 후 ollama serve</code><br />
                  <code className="bg-base px-1 rounded">Mac/Linux: OLLAMA_ORIGINS=* ollama serve</code>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="card space-y-2 text-sm text-slate-300">
        <h2 className="font-bold text-white">계정 정보</h2>
        <div className="grid grid-cols-2 gap-2">
          <div className="text-slate-500">이메일</div><div>{profile?.email}</div>
          <div className="text-slate-500">이름</div><div>{profile?.name || '-'}</div>
          <div className="text-slate-500">역할</div><div>{profile?.role === 'admin' ? '관리자' : '일반회원'}</div>
          <div className="text-slate-500">상태</div><div>{profile?.approved ? '승인됨' : '승인 대기'}</div>
        </div>
      </div>

      <div className="card text-xs text-slate-500 leading-relaxed">
        <div className="font-bold text-slate-400 mb-1">면책 고지</div>
        본 시스템은 학습·연구용 트레이딩 시뮬레이터이며, 실제 투자 권유가 아닙니다.
        모의투자·백테스트 결과가 미래 수익을 보장하지 않으며 투자 판단의 책임은 사용자 본인에게 있습니다.
      </div>
    </div>
  );
}
