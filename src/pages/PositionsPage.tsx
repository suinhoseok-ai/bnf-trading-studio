import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCandles, ALL_STOCKS, stockName } from '../lib/marketData';
import { getStrategy, initStrategy } from '../lib/strategies';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import type { UserPosition } from '../lib/types';
import StrategyPicker from '../components/StrategyPicker';

const shortRange = (interval: string) => (interval === '1d' ? '3mo' : '5d');

export default function PositionsPage() {
  const { profile, guestMode } = useAuth();
  const [positions, setPositions] = useState<UserPosition[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [signals, setSignals] = useState<Record<number, 'BUY' | 'SELL' | 'NEUTRAL'>>({});
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');

  // 등록 폼 상태
  const [fSymbol, setFSymbol] = useState('005930.KS');
  const [fStrat, setFStrat] = useState('bnf1');
  const [fPrice, setFPrice] = useState('');
  const [fShares, setFShares] = useState('');
  const [fAlert, setFAlert] = useState(true);

  const uid = profile?.id ?? 'guest';
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };

  const guestLoad = (): { positions: UserPosition[]; nextId: number } =>
    JSON.parse(localStorage.getItem('userPositions') ?? 'null') ?? { positions: [], nextId: 1 };
  const guestSave = (g: { positions: UserPosition[]; nextId: number }) =>
    localStorage.setItem('userPositions', JSON.stringify(g));

  const load = async () => {
    if (guestMode) {
      setPositions(guestLoad().positions.filter((p) => p.status === 'OPEN'));
      return;
    }
    const { data } = await supabase.from('bnf_user_positions').select('*').eq('user_id', uid).eq('status', 'OPEN').order('opened_at', { ascending: false });
    setPositions((data as unknown as UserPosition[]) ?? []);
  };
  useEffect(() => { load(); }, []);

  // 현재가 + 매도신호 갱신
  const refreshStatus = async (list: UserPosition[]) => {
    setChecking(true);
    const pmap: Record<string, number> = {};
    const smap: Record<number, 'BUY' | 'SELL' | 'NEUTRAL'> = {};
    for (const p of list) {
      const mod = getStrategy(p.strategy_code);
      try {
        await initStrategy(mod);
        const { candles } = await fetchCandles(p.symbol, mod.interval, mod.range);
        const rows = mod.compute(candles);
        const last = rows[rows.length - 1];
        pmap[p.symbol] = last?.close ?? Number(p.entry_price);
        smap[p.id] = last?.buy ? 'BUY' : last?.exit ? 'SELL' : 'NEUTRAL';
      } catch {
        pmap[p.symbol] = Number(p.entry_price);
        smap[p.id] = 'NEUTRAL';
      }
    }
    setPrices(pmap);
    setSignals(smap);
    setChecking(false);
  };
  useEffect(() => { if (positions.length) refreshStatus(positions); }, [positions]);

  const addPosition = async () => {
    const entry = Number(fPrice);
    const shares = Number(fShares);
    if (!entry || entry <= 0 || !shares || shares <= 0) { flash('매수가와 수량을 올바르게 입력하세요.'); return; }
    setAdding(true);
    try {
      const name = stockName(fSymbol);
      if (guestMode) {
        const g = guestLoad();
        g.positions.push({ id: g.nextId++, symbol: fSymbol, name, strategy_code: fStrat, entry_price: entry, shares, alert_enabled: fAlert, status: 'OPEN', opened_at: new Date().toISOString() });
        guestSave(g);
      } else {
        await supabase.from('bnf_user_positions').insert({ user_id: uid, symbol: fSymbol, name, strategy_code: fStrat, entry_price: entry, shares, alert_enabled: fAlert });
      }
      setFPrice(''); setFShares('');
      flash('포지션 등록 완료');
      await load();
    } finally {
      setAdding(false);
    }
  };

  const toggleAlert = async (p: UserPosition) => {
    if (guestMode) {
      const g = guestLoad();
      const gp = g.positions.find((x) => x.id === p.id);
      if (gp) gp.alert_enabled = !p.alert_enabled;
      guestSave(g);
    } else {
      await supabase.from('bnf_user_positions').update({ alert_enabled: !p.alert_enabled }).eq('id', p.id);
    }
    await load();
  };

  const closePosition = async (p: UserPosition) => {
    if (!confirm(`${p.name} 포지션을 청산(목록에서 종료) 처리할까요? 알림도 중단됩니다.`)) return;
    if (guestMode) {
      const g = guestLoad();
      const gp = g.positions.find((x) => x.id === p.id);
      if (gp) { gp.status = 'CLOSED'; gp.closed_at = new Date().toISOString(); }
      guestSave(g);
    } else {
      await supabase.from('bnf_user_positions').update({ status: 'CLOSED', closed_at: new Date().toISOString() }).eq('id', p.id);
    }
    flash('청산 처리 완료');
    await load();
  };

  const fmt = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 0 });

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-white">내 포지션</h1>
          <p className="text-sm text-slate-400 mt-1">
            실제 매수한 종목을 전략과 함께 등록하면, 해당 전략의 매도 시그널 발생 시 텔레그램으로 알려드립니다 (설정 페이지에서 텔레그램 연동 필요).
          </p>
        </div>
        {msg && <span className="badge bg-profit/20 text-profit">{msg}</span>}
      </header>

      {/* 등록 폼 */}
      <div className="card">
        <h3 className="font-bold text-white mb-3">포지션 등록</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-slate-400 block mb-1">종목</label>
            <select className="input w-auto" value={fSymbol} onChange={(e) => setFSymbol(e.target.value)}>
              {ALL_STOCKS.map((s) => <option key={s.symbol} value={s.symbol}>{s.name} ({s.market})</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">매수 전략 (매도 시그널 기준)</label>
            <StrategyPicker value={fStrat} onChange={setFStrat} />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">매수가 (원)</label>
            <input className="input w-36" type="number" min={0} value={fPrice} onChange={(e) => setFPrice(e.target.value)} placeholder="예: 185000" />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">수량 (주)</label>
            <input className="input w-28" type="number" min={0} step="any" value={fShares} onChange={(e) => setFShares(e.target.value)} placeholder="예: 10" />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300 pb-2">
            <input type="checkbox" checked={fAlert} onChange={(e) => setFAlert(e.target.checked)} />
            텔레그램 알림
          </label>
          <button className="btn-primary" onClick={addPosition} disabled={adding}>
            {adding ? '등록 중...' : '＋ 등록'}
          </button>
        </div>
      </div>

      {/* 목록 */}
      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-bold text-white">보유 포지션 ({positions.length})</h3>
          <button className="btn-ghost !py-1 !px-3 text-sm" onClick={() => refreshStatus(positions)} disabled={checking || positions.length === 0}>
            {checking ? '확인 중...' : '🔄 시그널 확인'}
          </button>
        </div>
        <table className="w-full whitespace-nowrap">
          <thead>
            <tr className="border-b border-edge">
              <th className="th">종목</th><th className="th">전략</th><th className="th">매수가</th><th className="th">수량</th>
              <th className="th">현재가</th><th className="th">평가손익</th><th className="th">현재 시그널</th>
              <th className="th">알림</th><th className="th">등록일</th><th className="th">액션</th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 && (
              <tr><td colSpan={10} className="td text-center text-slate-500 py-8">등록된 포지션이 없습니다. 위에서 실제 매수한 종목을 등록하세요.</td></tr>
            )}
            {positions.map((p) => {
              const cur = prices[p.symbol] ?? Number(p.entry_price);
              const pnl = Number(p.shares) * (cur - Number(p.entry_price));
              const pct = Number(p.entry_price) > 0 ? ((cur - Number(p.entry_price)) / Number(p.entry_price)) * 100 : 0;
              const sig = signals[p.id];
              return (
                <tr key={p.id} className="border-b border-edge/50">
                  <td className="td font-medium text-white">
                    <Link to={`/chart?symbol=${p.symbol}&strat=${p.strategy_code}`} className="hover:text-accent">{p.name || stockName(p.symbol)}</Link>
                  </td>
                  <td className="td text-slate-400 text-xs">{getStrategy(p.strategy_code).name.split('·')[0].trim()}</td>
                  <td className="td">{fmt(Number(p.entry_price))}</td>
                  <td className="td">{Number(p.shares).toLocaleString('ko-KR', { maximumFractionDigits: 4 })}주</td>
                  <td className="td">{fmt(cur)}</td>
                  <td className={`td font-bold ${pnl >= 0 ? 'text-up' : 'text-down'}`}>{fmt(pnl)}원 ({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)</td>
                  <td className="td">
                    {sig === 'SELL' ? <span className="badge bg-amber-500/20 text-amber-400">🔻 매도신호</span>
                      : sig === 'BUY' ? <span className="badge bg-up/20 text-up">매수신호</span>
                      : sig === 'NEUTRAL' ? <span className="text-slate-500">중립</span>
                      : <span className="text-slate-600">-</span>}
                  </td>
                  <td className="td">
                    <button onClick={() => toggleAlert(p)} title="알림 토글">
                      {p.alert_enabled ? <span className="badge bg-accent/20 text-accent">🔔 켜짐</span> : <span className="badge bg-edge text-slate-500">🔕 꺼짐</span>}
                    </button>
                  </td>
                  <td className="td text-slate-400">{new Date(p.opened_at).toLocaleDateString('ko-KR')}</td>
                  <td className="td"><button className="text-red-400 hover:underline text-sm" onClick={() => closePosition(p)}>청산 처리</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500 leading-relaxed">
        ※ 매도 시그널은 등록한 전략의 청산 조건(예: BNF1=상단밴드 도달, 돌파/박스=EMA20 이탈, 눌림목=스토캐스틱 과매수, 정배열=데드크로스, 과매도반등=5일선 회복)을 기준으로 판정합니다.
        {guestMode ? ' 게스트 모드에서는 브라우저에만 저장되며 서버 텔레그램 자동 알림은 로그인(Supabase) 상태에서 동작합니다.' : ' 알림이 켜진 포지션은 장중 설정한 매도 알림 주기마다 자동 검사되어 발송됩니다.'}
      </p>
    </div>
  );
}
