import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchIndexQuote, fetchCandles, KOSPI_STOCKS, KOSDAQ_STOCKS } from '../lib/marketData';
import { calcIndicators } from '../lib/indicators';
import { scoreSymbol } from '../lib/scanner';
import type { ScanResult } from '../lib/types';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import Stars from '../components/Stars';

interface IndexQuote { label: string; price: number; changePct: number }

export default function DashboardPage() {
  const { profile, guestMode, allowedStrategyCodes } = useAuth();
  const [indices, setIndices] = useState<IndexQuote[]>([]);
  const [signals, setSignals] = useState<ScanResult[]>([]);
  const [account, setAccount] = useState<{ cash: number; initial: number; posCount: number } | null>(null);
  const [scanning, setScanning] = useState(true);
  const [demo, setDemo] = useState(false);

  const bnfEnabled = allowedStrategyCodes.includes('bnf1');

  useEffect(() => {
    (async () => {
      // 지수
      const [kospi, kosdaq] = await Promise.all([fetchIndexQuote('^KS11'), fetchIndexQuote('^KQ11')]);
      setIndices([
        { label: 'KOSPI', price: kospi.price, changePct: kospi.changePct },
        { label: 'KOSDAQ', price: kosdaq.price, changePct: kosdaq.changePct },
      ]);
      if (kospi.demo) setDemo(true);
    })();

    // 오늘 신호: 주요 종목 상위 8개 간이 스캔 (15분봉)
    (async () => {
      const universe = [...KOSPI_STOCKS.slice(0, 6), ...KOSDAQ_STOCKS.slice(0, 2)];
      const results: ScanResult[] = [];
      for (const s of universe) {
        try {
          const { candles, demo: d } = await fetchCandles(s.symbol, '15m', '60d');
          if (d) setDemo(true);
          const rows = calcIndicators(candles);
          results.push(scoreSymbol(s.symbol, s.name, rows));
        } catch { /* skip */ }
      }
      results.sort((a, b) => b.score - a.score);
      setSignals(results);
      setScanning(false);
    })();

    // 모의투자 계좌 요약
    if (!guestMode && profile) {
      (async () => {
        const { data: acc } = await supabase.from('bnf_paper_accounts').select('*').eq('user_id', profile.id).maybeSingle();
        const { count } = await supabase
          .from('bnf_paper_positions')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', profile.id)
          .eq('status', 'OPEN');
        if (acc) setAccount({ cash: Number(acc.cash), initial: Number(acc.initial_balance), posCount: count ?? 0 });
      })();
    }
  }, [guestMode, profile]);

  const fmt = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">대시보드</h1>
          <p className="text-sm text-slate-400 mt-1">BNF 전략1 (볼린저밴드 수렴 회귀) · 15분봉 기준</p>
        </div>
        {demo && (
          <span className="badge bg-amber-500/20 text-amber-400">데모 데이터 (실시세 조회 불가 시 합성 데이터)</span>
        )}
      </header>

      {!bnfEnabled && (
        <div className="card bg-red-500/10 border-red-500/40 text-red-300 text-sm">
          현재 계정에서 BNF 전략1 사용 권한이 비활성화되어 있습니다. 관리자에게 문의하세요.
        </div>
      )}

      {/* 지수 + 계좌 카드 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {indices.map((ix) => (
          <div key={ix.label} className="card">
            <div className="text-xs text-slate-400">{ix.label}</div>
            <div className="text-xl font-bold text-white mt-1">{ix.price.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}</div>
            <div className={`text-sm mt-0.5 ${ix.changePct >= 0 ? 'text-up' : 'text-down'}`}>
              {ix.changePct >= 0 ? '▲' : '▼'} {Math.abs(ix.changePct).toFixed(2)}%
            </div>
          </div>
        ))}
        <div className="card">
          <div className="text-xs text-slate-400">모의투자 가용현금</div>
          <div className="text-xl font-bold text-white mt-1">
            {account ? `${fmt(account.cash)}원` : guestMode ? '게스트 모드' : '계좌 미개설'}
          </div>
          <div className="text-sm text-slate-400 mt-0.5">
            {account ? `보유 포지션 ${account.posCount}건` : <Link to="/paper" className="text-accent">모의투자 시작 →</Link>}
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-400">활성 전략</div>
          <div className="text-xl font-bold text-white mt-1">BNF 전략1</div>
          <div className={`text-sm mt-0.5 ${bnfEnabled ? 'text-profit' : 'text-red-400'}`}>
            {bnfEnabled ? '● 사용 가능' : '● 사용 불가'}
          </div>
        </div>
      </div>

      {/* 오늘 신호 */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-white">오늘 신호 · AI 추천 상위</h2>
          <Link to="/scanner" className="text-sm text-accent hover:underline">전체 스캔 →</Link>
        </div>
        {scanning ? (
          <div className="text-sm text-slate-400 animate-pulse py-8 text-center">주요 종목 스캔 중... (15분봉 데이터 수집)</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-edge">
                  <th className="th">종목</th>
                  <th className="th">현재가</th>
                  <th className="th">등락</th>
                  <th className="th">밴드폭 백분위</th>
                  <th className="th">수렴</th>
                  <th className="th">하단이탈</th>
                  <th className="th">점수</th>
                  <th className="th">추천도</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <tr key={s.symbol} className="border-b border-edge/50 hover:bg-edge/30">
                    <td className="td font-medium text-white">
                      <Link to={`/chart?symbol=${s.symbol}`} className="hover:text-accent">{s.name}</Link>
                    </td>
                    <td className="td">{fmt(s.price)}</td>
                    <td className={`td ${s.changePct >= 0 ? 'text-up' : 'text-down'}`}>{s.changePct.toFixed(2)}%</td>
                    <td className="td">{s.bwPctRank != null ? `하위 ${s.bwPctRank}%` : '-'}</td>
                    <td className="td">{s.isSqueezed ? <span className="badge bg-accent/20 text-accent">수렴</span> : <span className="text-slate-500">-</span>}</td>
                    <td className="td">{s.belowLower ? <span className="badge bg-up/20 text-up">이탈</span> : <span className="text-slate-500">-</span>}</td>
                    <td className="td font-bold text-white">{s.score}</td>
                    <td className="td"><Stars n={s.stars} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 전략 요약 */}
      <div className="card">
        <h2 className="font-bold text-white mb-3">BNF 전략1 매매 규칙 요약</h2>
        <div className="grid md:grid-cols-4 gap-3 text-sm">
          <div className="bg-base rounded-lg p-3 border border-edge">
            <div className="text-accent font-semibold mb-1">① 진입</div>
            <div className="text-slate-300 leading-relaxed">밴드폭 수렴(하위 25% + BW MA20 미만) 상태에서 15분봉 종가가 하단밴드 하향 이탈 시 가용 현금 10% 매수. 발산 구간 제외.</div>
          </div>
          <div className="bg-base rounded-lg p-3 border border-edge">
            <div className="text-amber-400 font-semibold mb-1">② 초기 손절</div>
            <div className="text-slate-300 leading-relaxed">상단밴드 타겟 거리의 절반만큼 하방 = 1:2 손익비 손절선 설정.</div>
          </div>
          <div className="bg-base rounded-lg p-3 border border-edge">
            <div className="text-profit font-semibold mb-1">③ 1차 익절</div>
            <div className="text-slate-300 leading-relaxed">중심선(MA20) 도달 시 50% 익절 → 즉시 손절가를 본절(진입가)로 이동. 손실 가능성 0%.</div>
          </div>
          <div className="bg-base rounded-lg p-3 border border-edge">
            <div className="text-profit font-semibold mb-1">④ 2차 익절</div>
            <div className="text-slate-300 leading-relaxed">잔여 50%는 상단밴드 도달 시 전량 익절 청산.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
