import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import PendingPage from './pages/PendingPage';
import DashboardPage from './pages/DashboardPage';
import ScannerPage from './pages/ScannerPage';
import StocksPage from './pages/StocksPage';
import ReportPage from './pages/ReportPage';
import PositionsPage from './pages/PositionsPage';
import TradingPage from './pages/TradingPage';
import ChartPage from './pages/ChartPage';
import BacktestPage from './pages/BacktestPage';
import PaperPage from './pages/PaperPage';
import AIPage from './pages/AIPage';
import AdminPage from './pages/AdminPage';
import SettingsPage from './pages/SettingsPage';

export default function App() {
  const { session, profile, loading, guestMode } = useAuth();

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center text-slate-400">
        <div className="text-center">
          <div className="text-2xl font-bold text-accent mb-2">BNF Trading Studio</div>
          <div className="text-sm animate-pulse">불러오는 중...</div>
        </div>
      </div>
    );
  }

  // 미로그인 (게스트 모드 제외)
  if (!guestMode && !session) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  // 로그인했으나 관리자 승인 대기
  if (!guestMode && profile && !profile.approved) {
    return (
      <Routes>
        <Route path="*" element={<PendingPage />} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/scanner" element={<ScannerPage />} />
        <Route path="/stocks" element={<StocksPage />} />
        <Route path="/report" element={<ReportPage />} />
        <Route path="/positions" element={<PositionsPage />} />
        <Route path="/trading" element={<TradingPage />} />
        <Route path="/chart" element={<ChartPage />} />
        <Route path="/backtest" element={<BacktestPage />} />
        <Route path="/paper" element={<PaperPage />} />
        <Route path="/ai" element={<AIPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route
          path="/admin"
          element={profile?.role === 'admin' ? <AdminPage /> : <Navigate to="/" replace />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
