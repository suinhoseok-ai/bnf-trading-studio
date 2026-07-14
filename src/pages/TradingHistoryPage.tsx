import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';

interface LiveTrade { id: number; symbol: string; name: string; strategy_code: string; side: string; trigger_note: string; order_type: string; order_price: number; qty: number; pnl: number; order_no: string; status: string; executed_at: string; mode: string }
interface TradeLog { id: number; level: string; event: string; detail: string; created_at: string }

const sideLabel: Record<string, { text: string; cls: string }> = {
  BUY: { text: '매수', cls: 'bg-up/20 text-up' },
  SELL_TP1: { text: '1차익절', cls: 'bg-profit/20 text-profit' },
  SELL_TP2: { text: '익절', cls: 'bg-profit/20 text-profit' },
  SELL_SL: { text: '손절/청산', cls: 'bg-amber-500/20 text-amber-400' },
  FORCE_SELL: { text: '강제매도', cls: 'bg-red-500/20 text-red-400' },
};

/** side(TP1/TP2)만으로 라벨을 정하면 손실 상태의 추세청산도 '익절'로 보인다. 실제 pnl 부호로 보정. */
function tradeLabel(side: string, pnl: number): { text: string; cls: string } {
  const base = sideLabel[side] ?? { text: side, cls: 'bg-edge text-slate-300' };
  if ((side === 'SELL_TP1' || side === 'SELL_TP2') && pnl < 0) {
    return { text: '청산(손실)', cls: 'bg-amber-500/20 text-amber-400' };
  }
  return base;
}

const RANGE_OPTIONS: { key: string; label: string; days: number | null }[] = [
  { key: '7d', label: '최근 7일', days: 7 },
  { key: '30d', label: '1개월', days: 30 },
  { key: '90d', label: '3개월', days: 90 },
  { key: '180d', label: '6개월', days: 180 },
  { key: 'all', label: '전체', days: null },
];

const LIMIT = 300;

export default function TradingHistoryPage() {
  const { profile, guestMode } = useAuth();
  const [range, setRange] = useState('30d');
  const [trades, setTrades] = useState<LiveTrade[]>([]);
  const [logs, setLogs] = useState<TradeLog[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (guestMode || !profile) return;
    setLoading(true);
    const days = RANGE_OPTIONS.find((r) => r.key === range)?.days ?? null;
    const cutoff = days != null ? new Date(Date.now() - days * 86400_000).toISOString() : null;

    let tq = supabase.from('bnf_live_trades').select('*').eq('user_id', profile.id).order('executed_at', { ascending: false }).limit(LIMIT);
    if (cutoff) tq = tq.gte('executed_at', cutoff);
    const { data: t } = await tq;
    setTrades((t as unknown as LiveTrade[]) ?? []);

    let lq = supabase.from('bnf_trade_logs').select('*').eq('user_id', profile.id).order('created_at', { ascending: false }).limit(LIMIT);
    if (cutoff) lq = lq.gte('created_at', cutoff);
    const { data: l } = await lq;
    setLogs((l as unknown as TradeLog[]) ?? []);
    setLoading(false);
  }, [guestMode, profile, range]);

  useEffect(() => { load(); }, [load]);

  const downloadCsv = () => {
    const head = 'id,일시,모드,종목,구분,수량,주문가,손익,트리거,주문번호,상태\n';
    const rows = trades.map((t) =>
      [t.id, t.executed_at, t.mode, t.name || t.symbol, t.side, t.qty, t.order_price, t.pnl, `"${(t.trigger_note ?? '').replace(/"/g, '""')}"`, t.order_no, t.status].join(','),
    ).join('\n');
    const blob = new Blob(['﻿' + head + rows], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `auto_trades_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const fmt = (n: number) => Math.round(n).toLocaleString('ko-KR');

  if (guestMode) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-ink">매매 이력</h1>
        <div className="card text-sm text-amber-300 bg-amber-500/10 border-amber-500/40">
          자동매매 이력은 로그인(Supabase 설정) 상태에서만 사용할 수 있습니다.
        </div>
      </div>
    );
  }

  // ── 대시보드 집계 (선택 기간 기준) ──
  const buyTrades = trades.filter((t) => t.side === 'BUY');
  const sellTrades = trades.filter((t) => t.side !== 'BUY');
  const realizedPnl = sellTrades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const wins = sellTrades.filter((t) => Number(t.pnl) > 0).length;
  const winRate = sellTrades.length > 0 ? (wins / sellTrades.length) * 100 : 0;
  const alertLogs = logs.filter((l) => l.level === 'warn' || l.level === 'error').length;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">📜 매매 이력</h1>
          <p className="text-sm text-slate-400 mt-1">자동매매 거래 이력 · 실행 로그 조회</p>
        </div>
        <Link to="/trading" className="btn-ghost !py-1 !px-3 text-sm">← 자동매매 설정으로</Link>
      </header>

      <div className="flex items-center gap-2 flex-wrap">
        {RANGE_OPTIONS.map((r) => (
          <button
            key={r.key}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${range === r.key ? 'bg-accent text-white' : 'bg-panel border border-edge text-slate-400 hover:bg-edge/60'}`}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </button>
        ))}
        {loading && <span className="text-xs text-slate-500">불러오는 중...</span>}
      </div>

      {/* ── 대시보드 ── */}
      <div className="card space-y-3">
        <h2 className="font-bold text-ink">📊 자동매매 대시보드</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">총 거래건수</div><div className="text-lg font-bold text-ink">{trades.length}건</div></div>
          <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">매수 / 매도</div><div className="text-lg font-bold text-ink">{buyTrades.length} / {sellTrades.length}</div></div>
          <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">실현손익 합계</div><div className={`text-lg font-bold ${realizedPnl >= 0 ? 'text-up' : 'text-down'}`}>{fmt(realizedPnl)}원</div></div>
          <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">승률 (매도 기준)</div><div className="text-lg font-bold text-ink">{sellTrades.length > 0 ? `${winRate.toFixed(1)}%` : '-'}</div></div>
          <div className="card !p-3 !bg-base"><div className="text-xs text-slate-400">경고·오류 로그</div><div className={`text-lg font-bold ${alertLogs > 0 ? 'text-down' : 'text-ink'}`}>{alertLogs}건</div></div>
        </div>
      </div>

      {/* ── 거래 이력 ── */}
      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-bold text-ink">📜 자동매매 거래 이력 ({trades.length}건)</h2>
          <button className="btn-ghost !py-1 !px-3 text-sm" onClick={downloadCsv} disabled={trades.length === 0}>CSV 다운로드</button>
        </div>
        <table className="w-full whitespace-nowrap">
          <thead>
            <tr className="border-b border-edge">
              <th className="th">일시</th><th className="th">모드</th><th className="th">종목</th><th className="th">구분</th>
              <th className="th">수량</th><th className="th">주문가</th><th className="th">추정손익</th><th className="th">트리거</th><th className="th">상태</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 && <tr><td colSpan={9} className="td text-center text-slate-500 py-8">선택한 기간에 자동매매 거래 이력이 없습니다.</td></tr>}
            {trades.map((t) => (
              <tr key={t.id} className="border-b border-edge/50">
                <td className="td text-slate-400">{new Date(t.executed_at).toLocaleString('ko-KR')}</td>
                <td className="td"><span className={`badge ${t.mode === 'real' ? 'bg-red-500/20 text-red-400' : 'bg-edge text-slate-400'}`}>{t.mode === 'real' ? '실전' : '모의'}</span></td>
                <td className="td text-ink">{t.name || t.symbol}</td>
                <td className="td"><span className={`badge ${tradeLabel(t.side, Number(t.pnl)).cls}`}>{tradeLabel(t.side, Number(t.pnl)).text}</span></td>
                <td className="td">{t.qty}주</td>
                <td className="td">{fmt(Number(t.order_price))}</td>
                <td className={`td font-bold ${Number(t.pnl) > 0 ? 'text-up' : Number(t.pnl) < 0 ? 'text-down' : 'text-slate-400'}`}>{fmt(Number(t.pnl))}원</td>
                <td className="td text-slate-400 max-w-[280px] truncate" title={t.trigger_note}>{t.trigger_note}</td>
                <td className="td">{t.status === 'SUBMITTED' ? <span className="text-profit">접수</span> : <span className="text-red-400">실패</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── 자동매매 로그 ── */}
      <div className="card">
        <h2 className="font-bold text-ink mb-2">🧾 자동매매 로그 ({logs.length}건)</h2>
        <div className="max-h-96 overflow-y-auto space-y-1 text-sm">
          {logs.length === 0 && <div className="text-slate-500 py-4 text-center">선택한 기간에 로그가 없습니다.</div>}
          {logs.map((l) => (
            <div key={l.id} className={`px-3 py-1.5 rounded flex gap-3 ${
              l.level === 'error' ? 'bg-red-500/10 text-red-300' : l.level === 'warn' ? 'bg-amber-500/10 text-amber-300' : 'bg-edge/40 text-slate-300'
            }`}>
              <span className="text-slate-500 shrink-0">{new Date(l.created_at).toLocaleString('ko-KR')}</span>
              <span className="font-semibold shrink-0">{l.event}</span>
              <span className="truncate" title={l.detail}>{l.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
