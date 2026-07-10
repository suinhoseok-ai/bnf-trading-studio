import { useState, FormEvent } from 'react';
import { supabase } from '../lib/supabase';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ type: 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { name } },
        });
        if (error) throw error;
        setMsg({
          type: 'info',
          text: '회원가입 완료! 관리자 승인 후 이용할 수 있습니다. (이메일 확인이 활성화된 경우 메일 인증도 필요합니다)',
        });
        setMode('login');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      setMsg({
        type: 'error',
        text: m.includes('Invalid login') ? '이메일 또는 비밀번호가 올바르지 않습니다.' : m,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">BNF Trading Studio</h1>
          <p className="text-accent mt-1 text-sm">AI Edition · 볼린저밴드 수렴 회귀 전략 시뮬레이터</p>
        </div>
        <div className="card">
          <div className="flex mb-5 bg-base rounded-lg p-1">
            {(['login', 'signup'] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setMsg(null); }}
                className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${
                  mode === m ? 'bg-accent text-white' : 'text-slate-400'
                }`}
              >
                {m === 'login' ? '로그인' : '회원가입'}
              </button>
            ))}
          </div>
          <form onSubmit={submit} className="space-y-3">
            {mode === 'signup' && (
              <input className="input" placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} required />
            )}
            <input className="input" type="email" placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input className="input" type="password" placeholder="비밀번호 (6자 이상)" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} required />
            {msg && (
              <div className={`text-sm rounded-lg p-3 ${msg.type === 'error' ? 'bg-red-500/10 text-red-400' : 'bg-accent/10 text-accent'}`}>
                {msg.text}
              </div>
            )}
            <button className="btn-primary w-full" disabled={busy}>
              {busy ? '처리 중...' : mode === 'login' ? '로그인' : '회원가입'}
            </button>
          </form>
          {mode === 'signup' && (
            <p className="text-xs text-slate-500 mt-4 leading-relaxed">
              가입 후 관리자의 승인이 필요합니다. 최초 가입자는 자동으로 관리자 권한이 부여됩니다.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
