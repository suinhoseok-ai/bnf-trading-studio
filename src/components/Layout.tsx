import { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const NAV = [
  { to: '/', label: '대시보드', icon: '📊' },
  { to: '/scanner', label: '종목 스캐너', icon: '🔍' },
  { to: '/stocks', label: '전체 종목', icon: '📋' },
  { to: '/report', label: '전체 리포트', icon: '📑' },
  { to: '/chart', label: '차트 분석', icon: '📈' },
  { to: '/backtest', label: '백테스트', icon: '⏱️' },
  { to: '/paper', label: '모의투자', icon: '💰' },
  { to: '/positions', label: '내 포지션', icon: '💼' },
  { to: '/ai', label: 'AI 분석 (Qwen3)', icon: '🤖' },
  { to: '/settings', label: '설정', icon: '⚙️' },
];

export default function Layout({ children }: { children: ReactNode }) {
  const { profile, signOut, guestMode } = useAuth();

  return (
    <div className="flex h-screen overflow-hidden">
      {/* 사이드바 */}
      <aside className="w-60 shrink-0 bg-panel border-r border-edge flex flex-col">
        <div className="p-4 border-b border-edge">
          <div className="text-lg font-bold text-white leading-tight">BNF Trading Studio</div>
          <div className="text-xs text-accent mt-0.5">AI Edition · 볼린저밴드 수렴 회귀</div>
        </div>
        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive ? 'bg-accent/20 text-accent font-semibold' : 'text-slate-300 hover:bg-edge/60'
                }`
              }
            >
              <span>{n.icon}</span> {n.label}
            </NavLink>
          ))}
          {profile?.role === 'admin' && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive ? 'bg-amber-500/20 text-amber-400 font-semibold' : 'text-amber-300/80 hover:bg-edge/60'
                }`
              }
            >
              <span>🛡️</span> 관리자
            </NavLink>
          )}
        </nav>
        <div className="p-3 border-t border-edge text-xs">
          <div className="text-slate-300 truncate">{profile?.name || profile?.email}</div>
          <div className="flex items-center justify-between mt-1">
            <span className={`badge ${profile?.role === 'admin' ? 'bg-amber-500/20 text-amber-400' : 'bg-edge text-slate-400'}`}>
              {profile?.role === 'admin' ? '관리자' : '일반회원'}
            </span>
            {!guestMode && (
              <button onClick={signOut} className="text-slate-400 hover:text-red-400">
                로그아웃
              </button>
            )}
          </div>
          {guestMode && (
            <div className="mt-2 text-amber-400/80 leading-snug">
              게스트 데모 모드 (Supabase 미설정)
            </div>
          )}
        </div>
      </aside>

      {/* 메인 */}
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
