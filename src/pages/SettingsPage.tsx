import { useState } from 'react';
import { useOllamaConfig } from '../hooks/useOllamaConfig';
import { useTelegramConfig } from '../hooks/useTelegramConfig';
import { testOllama } from '../lib/ollama';
import { sendTelegramTest, TelegramConfig } from '../lib/telegram';
import { UNIVERSE_OPTIONS } from '../lib/marketData';
import { useAuth } from '../context/AuthContext';
import StrategyPicker from '../components/StrategyPicker';

export default function SettingsPage() {
  const { profile, guestMode } = useAuth();
  const [config, saveConfig] = useOllamaConfig();
  const [url, setUrl] = useState(config.url);
  const [model, setModel] = useState(config.model);
  const [testResult, setTestResult] = useState<{ ok: boolean; models: string[]; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tgSaving, setTgSaving] = useState(false);

  // ── 텔레그램 ──
  const [tgConfig, saveTg] = useTelegramConfig();
  const [tg, setTg] = useState<TelegramConfig>(tgConfig);
  const [tgSaved, setTgSaved] = useState(false);
  const [tgTest, setTgTest] = useState<{ ok: boolean; error?: string } | null>(null);
  const [tgTesting, setTgTesting] = useState(false);
  const setTgField = <K extends keyof TelegramConfig>(k: K, v: TelegramConfig[K]) => setTg((prev) => ({ ...prev, [k]: v }));

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestResult(await testOllama({ url, model }));
    setTesting(false);
  };

  const save = async () => {
    setSaving(true);
    await saveConfig({ url: url.trim(), model: model.trim() });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const saveTelegram = async () => {
    setTgSaving(true);
    await saveTg({ ...tg, botToken: tg.botToken.trim(), chatId: tg.chatId.trim() });
    setTgSaving(false);
    setTgSaved(true);
    setTimeout(() => setTgSaved(false), 2000);
  };

  const testTelegram = async () => {
    setTgTesting(true);
    setTgTest(null);
    const text = `✅ <b>[BNF Trading Studio] 테스트 알림</b>\n텔레그램 연동이 정상 동작합니다.\n시각: ${new Date().toLocaleString('ko-KR')}`;
    setTgTest(await sendTelegramTest(tg.botToken.trim(), tg.chatId.trim(), text));
    setTgTesting(false);
  };

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">설정</h1>
        <p className="text-sm text-slate-400 mt-1">사용자별 연동 설정 — {guestMode ? '게스트: 브라우저에 저장' : '계정에 저장됩니다'}</p>
      </header>

      <div className="grid xl:grid-cols-2 gap-4 items-start">

      {/* ── Ollama ── */}
      <div className="card space-y-4">
        <h2 className="font-bold text-ink">🤖 Qwen3 (Ollama) 연결</h2>
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
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? '저장 중...' : saved ? '✓ 저장됨' : '저장'}</button>
        </div>
        {testResult && (
          <div className={`text-sm rounded-lg p-3 ${testResult.ok ? 'bg-profit/10 text-profit' : 'bg-red-500/10 text-red-400'}`}>
            {testResult.ok ? (
              <>✓ 연결 성공! 설치된 모델: {testResult.models.length > 0 ? testResult.models.join(', ') : '(없음 — ollama pull 필요)'}</>
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

      {/* ── 텔레그램 알림 ── */}
      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-ink">📨 텔레그램 알림 (개인 봇)</h2>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={tg.enabled} onChange={(e) => setTgField('enabled', e.target.checked)} />
            알림 켜기
          </label>
        </div>
        <p className="text-xs text-slate-500 leading-relaxed">
          지정한 주기마다 <b>매수 가능 종목</b>과 <b>보유 모의투자 종목의 매도 시그널</b>을 텔레그램으로 받아봅니다 (AI 미사용, 시스템 계산).
          24시간 자동 발송은 로그인(Supabase) 상태에서 동작하며, Netlify 예약 함수 + 서버 환경변수 설정이 필요합니다.
        </p>

        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400 block mb-1">봇 토큰 (BotFather에서 발급)</label>
            <input className="input" value={tg.botToken} onChange={(e) => setTgField('botToken', e.target.value)} placeholder="123456:ABC-DEF..." />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Chat ID (내 채팅 ID)</label>
            <input className="input" value={tg.chatId} onChange={(e) => setTgField('chatId', e.target.value)} placeholder="예: 987654321" />
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400 block mb-1">매수·관심종목 알림 주기 (분)</label>
            <input className="input" type="number" min={5} step={5} value={tg.intervalMin} onChange={(e) => setTgField('intervalMin', Math.max(5, Number(e.target.value)))} />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">모의투자 매도 알림 주기 (분)</label>
            <input className="input" type="number" min={5} step={5} value={tg.sellIntervalMin} onChange={(e) => setTgField('sellIntervalMin', Math.max(5, Number(e.target.value)))} />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">매수 스캔 전략</label>
            <StrategyPicker value={tg.strategy} onChange={(c) => setTgField('strategy', c)} className="input w-full" />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">매수 스캔 대상</label>
            <select className="input w-full" value={tg.universe} onChange={(e) => setTgField('universe', e.target.value)}>
              {UNIVERSE_OPTIONS.filter((u) => u.key !== 'WATCH').map((u) => (
                <option key={u.key} value={u.key}>{u.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex gap-4 text-sm text-slate-300 flex-wrap">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={tg.notifyBuy} onChange={(e) => setTgField('notifyBuy', e.target.checked)} />
            매수 시그널 알림 (유니버스)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={tg.notifyWatch} onChange={(e) => setTgField('notifyWatch', e.target.checked)} />
            관심종목 매수/매도 알림
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={tg.notifySell} onChange={(e) => setTgField('notifySell', e.target.checked)} />
            모의투자 매도 시그널 알림
          </label>
        </div>
        <p className="text-xs text-slate-500">알림은 한국 정규장 시간(평일 09:00~15:30)에만 발송됩니다.</p>

        <div className="border-t border-edge pt-3 space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-ink">
            <input
              type="checkbox"
              checked={tg.regimeNotify.enabled}
              onChange={(e) => setTgField('regimeNotify', { ...tg.regimeNotify, enabled: e.target.checked })}
            />
            시장국면 알림 받기 (KOSPI/KOSDAQ 상승·횡보·하락 판정 결과)
          </label>
          <div className="flex gap-4 text-sm text-slate-300 flex-wrap pl-6">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={tg.regimeNotify.preopen}
                onChange={(e) => setTgField('regimeNotify', { ...tg.regimeNotify, preopen: e.target.checked })}
              />
              장전 (08:30)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={tg.regimeNotify.midday}
                onChange={(e) => setTgField('regimeNotify', { ...tg.regimeNotify, midday: e.target.checked })}
              />
              장중 (11:00)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={tg.regimeNotify.close}
                onChange={(e) => setTgField('regimeNotify', { ...tg.regimeNotify, close: e.target.checked })}
              />
              장마감 (15:30)
            </label>
          </div>
        </div>

        <div className="flex gap-2">
          <button className="btn-ghost" onClick={testTelegram} disabled={tgTesting || !tg.botToken || !tg.chatId}>
            {tgTesting ? '전송 중...' : '테스트 발송'}
          </button>
          <button className="btn-primary" onClick={saveTelegram} disabled={tgSaving}>{tgSaving ? '저장 중...' : tgSaved ? '✓ 저장됨' : '저장'}</button>
        </div>
        {tgTest && (
          <div className={`text-sm rounded-lg p-3 ${tgTest.ok ? 'bg-profit/10 text-profit' : 'bg-red-500/10 text-red-400'}`}>
            {tgTest.ok ? '✓ 테스트 메시지를 발송했습니다. 텔레그램을 확인하세요.' : `✗ 발송 실패: ${tgTest.error}`}
          </div>
        )}

        <details className="text-xs text-slate-500 leading-relaxed">
          <summary className="cursor-pointer text-slate-400">봇 토큰 · Chat ID 발급 방법</summary>
          <ol className="list-decimal ml-5 mt-2 space-y-1">
            <li>텔레그램에서 <code className="bg-base px-1 rounded">@BotFather</code> 검색 → <code className="bg-base px-1 rounded">/newbot</code> 으로 봇 생성 → <b>봇 토큰</b> 복사.</li>
            <li>생성한 내 봇과 대화창을 열고 아무 메시지나 전송 (예: <code className="bg-base px-1 rounded">/start</code>).</li>
            <li>브라우저에서 <code className="bg-base px-1 rounded">https://api.telegram.org/bot(봇토큰)/getUpdates</code> 접속 → <code className="bg-base px-1 rounded">chat.id</code> 값이 <b>Chat ID</b>.</li>
            <li>위 두 값을 입력하고 [테스트 발송]으로 확인 후 [저장].</li>
          </ol>
        </details>
      </div>

      {/* ── 계정 정보 ── */}
      <div className="card space-y-2 text-sm text-slate-300">
        <h2 className="font-bold text-ink">계정 정보</h2>
        <div className="grid grid-cols-2 gap-2 max-w-md">
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
    </div>
  );
}
