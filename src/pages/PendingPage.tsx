import { useAuth } from '../context/AuthContext';

export default function PendingPage() {
  const { profile, signOut, refreshProfile } = useAuth();
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card max-w-md text-center">
        <div className="text-4xl mb-4">⏳</div>
        <h2 className="text-xl font-bold text-white mb-2">관리자 승인 대기 중</h2>
        <p className="text-sm text-slate-400 leading-relaxed">
          <span className="text-slate-200">{profile?.email}</span> 계정의 가입 신청이 접수되었습니다.
          <br />
          관리자가 승인하면 모든 기능을 이용할 수 있습니다.
        </p>
        <div className="flex gap-2 justify-center mt-6">
          <button className="btn-primary" onClick={refreshProfile}>승인 상태 새로고침</button>
          <button className="btn-ghost" onClick={signOut}>로그아웃</button>
        </div>
      </div>
    </div>
  );
}
