import { useEffect, useState } from 'react';
import { fetchCandles, ALL_STOCKS, stockName } from '../lib/marketData';
import { calcIndicators } from '../lib/indicators';
import { processPosition } from '../lib/paper';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';

interface Account { cash: number; initial_balance: number }
interface Position {
  id: number; symbol: string; name: string; entry_price: number; shares: number;
  sl: number; tp1_hit: boolean; opened_at: string; status: string;
}
interface Trade {
  id: number; symbol: string; name: string; side: string; price: number;
  shares: number; pnl: number; note: string; executed_at: string;
}

const INITIAL_BALANCE = 10_000_000;

export default function PaperPage() {
  const { profile, guestMode, allowedStrategyCodes } = useAuth();
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const bnfEnabled = allowedStrategyCodes.includes('bnf1');
  const uid = profile?.id ?? 'guest';

  // ── 게스트 모드 localStorage 저장소 ──
  const guestLoad = () => {
    const g = JSON.parse(localStorage.getItem('paper') ?? 'null');
    return g ?? { account: null, positions: [], trades: [], nextId: 1 };
  };
  const guestSave = (g: ReturnType<typeof guestLoad>) => localStorage.setItem('paper', JSON.stringify(g));

  const load = async () => {
    if (guestMode) {
      const g = guestLoad();
      setAccount(g.account);
      setPositions(g.positions.filter((p: Position) => p.status === 'OPEN'));
      setTrades([...g.trades].reverse().slice(0, 50));
      return;
    }
    const { data: acc } = await supabase.from('bnf_paper_accounts').select('*').eq('user_id', uid).maybeSingle();
    setAccount(acc ? { cash: Number(acc.cash), initial_balance: Number(acc.initial_balance) } : null);
    const { data: pos } = await supabase.from('bnf_paper_positions').select('*').eq('user_id', uid).eq('status', 'OPEN').order('opened_at', { ascending: false });
    setPositions((pos as unknown as Position[]) ?? []);
    const { data: trd } = await supabase.from('bnf_paper_trades').select('*').eq('user_id', uid).order('executed_at', { ascending: false }).limit(50);
    setTrades((trd as unknown as Trade[]) ?? []);
  };
  useEffect(() => { load(); }, []);

  // 보유 종목 현재가 갱신
  useEffect(() => {
    (async () => {
      const map: Record<string, number> = {};
      for (const p of positions) {
        try {
          const { candles } = await fetchCandles(p.symbol, '15m', '5d');
          map[p.symbol] = candles[candles.length - 1]?.close ?? p.entry_price;
        } catch { map[p.symbol] = p.entry_price; }
      }
      setPrices(map);
    })();
  }, [positions]);

  const openAccount = async () => {
    if (guestMode) {
      const g = guestLoad();
      g.account = { cash: INITIAL_BALANCE, initial_balance: INITIAL_BALANCE };
      guestSave(g);
      await load();
      return;
    }
    await supabase.from('bnf_paper_accounts').upsert({ user_id: uid, cash: INITIAL_BALANCE, initial_balance: INITIAL_BALANCE });
    await load();
  };

  const resetAccount = async () => {
    if (!confirm('모의투자 계좌를 초기화할까요? 모든 포지션과 거래내역이 삭제됩니다.')) return;
    if (guestMode) {
      guestSave({ account: { cash: INITIAL_BALANCE, initial_balance: INITIAL_BALANCE }, positions: [], trades: [], nextId: 1 });
      await load();
      return;
    }
    await supabase.from('bnf_paper_positions').delete().eq('user_id', uid);
    await supabase.from('bnf_paper_trades').delete().eq('user_id', uid);
    await supabase.from('bnf_paper_accounts').upsert({ user_id: uid, cash: INITIAL_BALANCE, initial_balance: INITIAL_BALANCE, updated_at: new Date().toISOString() });
    await load();
  };

  /** 자동매매 실행: 보유 포지션 청산 규칙 적용 + 관심/주요종목 신규 신호 매수 */
  const runAutoTrade = async () => {
    if (!account || !bnfEnabled) return;
    setBusy(true);
    const newLog: string[] = [];
    let cash = account.cash;

    const g = guestMode ? guestLoad() : null;

    try {
      // ── 1. 보유 포지션 처리 ──
      for (const pos of positions) {
        const { candles } = await fetchCandles(pos.symbol, '15m', '60d');
        const rows = calcIndicators(candles);
        const { events, updated } = processPosition(
          { symbol: pos.symbol, name: pos.name, entry_price: Number(pos.entry_price), shares: Number(pos.shares), sl: Number(pos.sl), tp1_hit: pos.tp1_hit, opened_at: pos.opened_at },
          rows,
        );
        for (const ev of events) {
          cash += ev.shares * ev.price;
          newLog.push(`[${ev.side}] ${pos.name} ${ev.note} · ${ev.price.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}원 · 손익 ${ev.pnl.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}원`);
          if (guestMode && g) {
            g.trades.push({ id: g.nextId++, symbol: pos.symbol, name: pos.name, side: ev.side, price: ev.price, shares: ev.shares, pnl: ev.pnl, note: ev.note, executed_at: new Date(ev.time * 1000).toISOString() });
          } else {
            await supabase.from('bnf_paper_trades').insert({ user_id: uid, symbol: pos.symbol, name: pos.name, side: ev.side, price: ev.price, shares: ev.shares, pnl: ev.pnl, note: ev.note, executed_at: new Date(ev.time * 1000).toISOString() });
          }
        }
        if (updated == null) {
          if (guestMode && g) {
            const gp = g.positions.find((p: Position) => p.id === pos.id);
            if (gp) { gp.status = 'CLOSED'; }
          } else {
            await supabase.from('bnf_paper_positions').update({ status: 'CLOSED', closed_at: new Date().toISOString() }).eq('id', pos.id);
          }
        } else if (events.length > 0) {
          if (guestMode && g) {
            const gp = g.positions.find((p: Position) => p.id === pos.id);
            if (gp) { gp.shares = updated.shares; gp.sl = updated.sl; gp.tp1_hit = updated.tp1_hit; }
          } else {
            await supabase.from('bnf_paper_positions').update({ shares: updated.shares, sl: updated.sl, tp1_hit: updated.tp1_hit }).eq('id', pos.id);
          }
        }
      }

      // ── 2. 신규 매수 신호 스캔 (주요 종목 전체) ──
      const held = new Set(positions.map((p) => p.symbol));
      for (const s of ALL_STOCKS) {
        if (held.has(s.symbol)) continue;
        try {
          const { candles } = await fetchCandles(s.symbol, '15m', '60d');
          const rows = calcIndicators(candles);
          const last = rows[rows.length - 1];
          if (last?.buySignal && last.upperBand != null) {
            const investAmount = cash * 0.1;
            if (investAmount < 1000) continue;
            const shares = investAmount / last.close;
            const targetDist = last.upperBand - last.close;
            const sl = last.close - targetDist / 2;
            cash -= investAmount;
            newLog.push(`[매수] ${s.name} · ${last.close.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}원 · 손절 ${sl.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}원 (현금 10% 진입)`);
            const nowIso = new Date(last.time * 1000).toISOString();
            if (guestMode && g) {
              g.positions.push({ id: g.nextId++, symbol: s.symbol, name: s.name, entry_price: last.close, shares, sl, tp1_hit: false, opened_at: nowIso, status: 'OPEN' });
              g.trades.push({ id: g.nextId++, symbol: s.symbol, name: s.name, side: 'BUY', price: last.close, shares, pnl: 0, note: 'BNF1 매수 신호', executed_at: nowIso });
            } else {
              await supabase.from('bnf_paper_positions').insert({ user_id: uid, symbol: s.symbol, name: s.name, entry_price: last.close, shares, sl, tp1_hit: false, opened_at: nowIso });
              await supabase.from('bnf_paper_trades').insert({ user_id: uid, symbol: s.symbol, name: s.name, side: 'BUY', price: last.close, shares, pnl: 0, note: 'BNF1 매수 신호', executed_at: nowIso });
            }
          }
        } catch { /* skip symbol */ }
      }

      // ── 3. 현금 잔고 반영 ──
      if (guestMode && g) {
        g.account.cash = cash;
        guestSave(g);
      } else {
        await supabase.from('bnf_paper_accounts').update({ cash, updated_at: new Date().toISOString() }).eq('user_id', uid);
      }
      if (newLog.length === 0) newLog.push('신규 신호 및 청산 이벤트가 없습니다.');
      setLog(newLog);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const manualClose = async (pos: Position) => {
    const price = prices[pos.symbol] ?? Number(pos.entry_price);
    if (!confirm(`${pos.name} 포지션을 현재가 ${price.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}원에 수동 청산할까요?`)) return;
    const pnl = Number(pos.shares) * (price - Number(pos.entry_price));
    const proceeds = Number(pos.shares) * price;
    if (guestMode) {
      const g = guestLoad();
      const gp = g.positions.find((p: Position) => p.id === pos.id);
      if (gp) gp.status = 'CLOSED';
      g.trades.push({ id: g.nextId++, symbol: pos.symbol, name: pos.name, side: 'SELL_MANUAL', price, shares: pos.shares, pnl, note: '수동 청산', executed_at: new Date().toISOString() });
      g.account.cash += proceeds;
      guestSave(g);
    } else {
      await supabase.from('bnf_paper_positions').update({ status: 'CLOSED', closed_at: new Date().toISOString() }).eq('id', pos.id);
      await supabase.from('bnf_paper_trades').insert({ user_id: uid, symbol: pos.symbol, name: pos.name, side: 'SELL_MANUAL', price, shares: pos.shares, pnl, note: '수동 청산' });
      await supabase.from('bnf_paper_accounts').update({ cash: (account?.cash ?? 0) + proceeds, updated_at: new Date().toISOString() }).eq('user_id', uid);
    }
    await load();
  };

  const fmt = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });
  const positionValue = positions.reduce((a, p) => a + Number(p.shares) * (prices[p.symbol] ?? Number(p.entry_price)), 0);
  const totalEquity = (account?.cash ?? 0) + positionValue;
  const totalReturn = account ? ((totalEquity - account.initial_balance) / account.initial_balance) * 100 : 0;

  const sideLabel: Record<string, { text: string; cls: string }> = {
    BUY: { text: '매수', cls: 'bg-up/20 text-up' },
    SELL_TP1: { text: '1차익절', cls: 'bg-profit/20 text-profit' },
    SELL_TP2: { text: '전량익절', cls: 'bg-profit/20 text-profit' },
    SELL_SL: { text: '손절', cls: 'bg-amber-500/20 text-amber-400' },
    SELL_MANUAL: { text: '수동청산', cls: 'bg-edge text-slate-300' },
  };

  if (!account) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-white">모의투자</h1>
        <div className="card text-center py-12">
          <div className="text-4xl mb-3">💰</div>
          <p className="text-slate-300 mb-1">가상 계좌를 개설하고 BNF 전략1 모의투자를 시작하세요.</p>
          <p className="text-sm text-slate-500 mb-5">초기 자본금 1,000만원 · 신호당 가용현금 10% 진입 · 1:2 손익비</p>
          <button className="btn-primary" onClick={openAccount}>가상 계좌 개설 (1,000만원)</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">모의투자</h1>
          <p className="text-sm text-slate-400 mt-1">BNF 전략1 자동매매 시뮬레이션 (15분봉 신호 기반)</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-primary" onClick={runAutoTrade} disabled={busy || !bnfEnabled}>
            {busy ? '자동매매 실행 중...' : '⚡ 자동매매 스캔 실행'}
          </button>
          <button className="btn-danger" onClick={resetAccount}>계좌 초기화</button>
        </div>
      </header>

      {/* 계좌 요약 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card !p-3">
          <div className="text-xs text-slate-400">총 평가자산</div>
          <div className="text-lg font-bold text-white">{fmt(totalEquity)}원</div>
        </div>
        <div className="card !p-3">
          <div className="text-xs text-slate-400">가용 현금</div>
          <div className="text-lg font-bold text-white">{fmt(account.cash)}원</div>
        </div>
        <div className="card !p-3">
          <div className="text-xs text-slate-400">보유 평가액</div>
          <div className="text-lg font-bold text-white">{fmt(positionValue)}원</div>
        </div>
        <div className="card !p-3">
          <div className="text-xs text-slate-400">총 수익률</div>
          <div className={`text-lg font-bold ${totalReturn >= 0 ? 'text-up' : 'text-down'}`}>{totalReturn.toFixed(2)}%</div>
        </div>
      </div>

      {/* 실행 로그 */}
      {log.length > 0 && (
        <div className="card">
          <h3 className="font-bold text-white mb-2">자동매매 실행 결과</h3>
          <div className="space-y-1 text-sm">
            {log.map((l, i) => (
              <div key={i} className={`px-3 py-1.5 rounded ${l.includes('[매수]') ? 'bg-up/10 text-up' : l.includes('익절') ? 'bg-profit/10 text-profit' : 'bg-edge/50 text-slate-300'}`}>{l}</div>
            ))}
          </div>
        </div>
      )}

      {/* 보유 포지션 */}
      <div className="card overflow-x-auto">
        <h3 className="font-bold text-white mb-2">보유 포지션 ({positions.length})</h3>
        <table className="w-full">
          <thead>
            <tr className="border-b border-edge">
              <th className="th">종목</th><th className="th">진입가</th><th className="th">현재가</th><th className="th">수량</th>
              <th className="th">손절가</th><th className="th">1차익절</th><th className="th">평가손익</th><th className="th">액션</th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 && <tr><td colSpan={8} className="td text-center text-slate-500 py-8">보유 포지션이 없습니다. [자동매매 스캔 실행]으로 신호를 탐색하세요.</td></tr>}
            {positions.map((p) => {
              const cur = prices[p.symbol] ?? Number(p.entry_price);
              const pnl = Number(p.shares) * (cur - Number(p.entry_price));
              return (
                <tr key={p.id} className="border-b border-edge/50">
                  <td className="td font-medium text-white">{p.name || stockName(p.symbol)}</td>
                  <td className="td">{fmt(Number(p.entry_price))}</td>
                  <td className="td">{fmt(cur)}</td>
                  <td className="td">{Number(p.shares).toFixed(2)}주</td>
                  <td className="td text-amber-400">{fmt(Number(p.sl))}{p.tp1_hit && <span className="text-xs ml-1">(본절)</span>}</td>
                  <td className="td">{p.tp1_hit ? <span className="badge bg-profit/20 text-profit">완료</span> : '-'}</td>
                  <td className={`td font-bold ${pnl >= 0 ? 'text-up' : 'text-down'}`}>{fmt(pnl)}원</td>
                  <td className="td"><button className="text-red-400 hover:underline text-sm" onClick={() => manualClose(p)}>수동청산</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 거래 내역 */}
      <div className="card overflow-x-auto">
        <h3 className="font-bold text-white mb-2">거래 내역 (최근 50건)</h3>
        <table className="w-full">
          <thead>
            <tr className="border-b border-edge">
              <th className="th">일시</th><th className="th">종목</th><th className="th">구분</th>
              <th className="th">가격</th><th className="th">수량</th><th className="th">손익</th><th className="th">비고</th>
            </tr>
          </thead>
          <tbody>
            {trades.length === 0 && <tr><td colSpan={7} className="td text-center text-slate-500 py-8">거래 내역이 없습니다.</td></tr>}
            {trades.map((t) => (
              <tr key={t.id} className="border-b border-edge/50">
                <td className="td text-slate-400">{new Date(t.executed_at).toLocaleString('ko-KR')}</td>
                <td className="td text-white">{t.name || stockName(t.symbol)}</td>
                <td className="td"><span className={`badge ${sideLabel[t.side]?.cls ?? ''}`}>{sideLabel[t.side]?.text ?? t.side}</span></td>
                <td className="td">{fmt(Number(t.price))}</td>
                <td className="td">{Number(t.shares).toFixed(2)}주</td>
                <td className={`td font-bold ${Number(t.pnl) > 0 ? 'text-up' : Number(t.pnl) < 0 ? 'text-down' : 'text-slate-400'}`}>{fmt(Number(t.pnl))}원</td>
                <td className="td text-slate-400">{t.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
