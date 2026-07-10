import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ALL_STOCKS, fetchQuote, fetchFundamentals, fmtKRWLarge, Quote, Fundamentals } from '../lib/marketData';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';

const PAGE_SIZE = 20;
type Row = { quote?: Quote; fund?: Fundamentals };

export default function StocksPage() {
  const { profile, guestMode } = useAuth();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Record<string, Row>>({});
  const [loading, setLoading] = useState(false);
  const [watchlist, setWatchlist] = useState<{ symbol: string; name: string }[]>([]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ALL_STOCKS;
    return ALL_STOCKS.filter((s) => s.name.toLowerCase().includes(q) || s.symbol.toLowerCase().includes(q));
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageStocks = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  useEffect(() => { setPage(0); }, [search]);

  const loadWatchlist = async () => {
    if (guestMode) { setWatchlist(JSON.parse(localStorage.getItem('watchlist') ?? '[]')); return; }
    const { data: w } = await supabase.from('bnf_watchlist').select('symbol,name').eq('user_id', profile!.id);
    setWatchlist((w as { symbol: string; name: string }[]) ?? []);
  };
  useEffect(() => { loadWatchlist(); }, []);

  // 현재 페이지 종목 시세/재무 로드
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const batch = 6;
      for (let i = 0; i < pageStocks.length; i += batch) {
        const slice = pageStocks.slice(i, i + batch);
        await Promise.all(slice.map(async (s) => {
          if (data[s.symbol]?.quote) return;
          try {
            const [quote, fund] = await Promise.all([fetchQuote(s.symbol), fetchFundamentals(s.symbol)]);
            if (!cancelled) setData((prev) => ({ ...prev, [s.symbol]: { quote, fund } }));
          } catch { /* skip */ }
        }));
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, search]);

  const toggleWatch = async (symbol: string, name: string) => {
    const exists = watchlist.some((w) => w.symbol === symbol);
    if (guestMode) {
      const next = exists ? watchlist.filter((w) => w.symbol !== symbol) : [...watchlist, { symbol, name }];
      localStorage.setItem('watchlist', JSON.stringify(next));
      setWatchlist(next);
      return;
    }
    if (exists) await supabase.from('bnf_watchlist').delete().eq('user_id', profile!.id).eq('symbol', symbol);
    else await supabase.from('bnf_watchlist').insert({ user_id: profile!.id, symbol, name });
    await loadWatchlist();
  };

  const fmt = (n: number | undefined | null) => (n == null || n === 0 ? '-' : n.toLocaleString('ko-KR', { maximumFractionDigits: 0 }));
  const fmt2 = (n: number | undefined | null) => (n == null ? '-' : n.toFixed(2));

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">전체 종목</h1>
          <p className="text-sm text-slate-400 mt-1">시총 상위 {ALL_STOCKS.length}개 종목 · 종목명을 클릭하면 차트, ☆로 관심종목 등록</p>
        </div>
        <input
          className="input w-64"
          placeholder="종목명 또는 코드 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </header>

      {loading && <div className="text-sm text-accent animate-pulse">시세 불러오는 중...</div>}

      <div className="card overflow-x-auto">
        <table className="w-full whitespace-nowrap">
          <thead>
            <tr className="border-b border-edge">
              <th className="th">관심</th><th className="th">종목</th><th className="th">현재가</th><th className="th">등락</th>
              <th className="th">전일</th><th className="th">시가</th><th className="th">고가</th><th className="th">저가</th>
              <th className="th">거래량</th><th className="th">대금</th><th className="th">시총</th>
              <th className="th">PER</th><th className="th">PBR</th><th className="th">EPS</th>
            </tr>
          </thead>
          <tbody>
            {pageStocks.map((s) => {
              const row = data[s.symbol];
              const q = row?.quote;
              const f = row?.fund;
              const up = (q?.changePct ?? 0) >= 0;
              return (
                <tr key={s.symbol} className="border-b border-edge/50 hover:bg-edge/30">
                  <td className="td">
                    <button onClick={() => toggleWatch(s.symbol, s.name)} title="관심종목 토글">
                      {watchlist.some((w) => w.symbol === s.symbol) ? '⭐' : '☆'}
                    </button>
                  </td>
                  <td className="td font-medium text-white">
                    <Link to={`/chart?symbol=${s.symbol}`} className="hover:text-accent">{s.name}</Link>
                    <span className="text-xs text-slate-500 ml-1">{s.market}</span>
                  </td>
                  <td className="td text-white">{fmt(q?.price)}</td>
                  <td className={`td ${up ? 'text-up' : 'text-down'}`}>{q ? `${q.changePct.toFixed(2)}%` : '-'}</td>
                  <td className="td text-slate-400">{fmt(q?.prevClose)}</td>
                  <td className="td text-slate-400">{fmt(q?.open)}</td>
                  <td className="td text-up">{fmt(q?.high)}</td>
                  <td className="td text-down">{fmt(q?.low)}</td>
                  <td className="td">{fmt(q?.volume)}</td>
                  <td className="td">{fmtKRWLarge(q?.tradeValue)}</td>
                  <td className="td">{fmtKRWLarge(f?.marketCap)}</td>
                  <td className="td">{f?.per != null ? fmt2(f.per) + '배' : '-'}</td>
                  <td className="td">{f?.pbr != null ? fmt2(f.pbr) + '배' : '-'}</td>
                  <td className="td">{f?.eps != null ? fmt(Math.round(f.eps)) : '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 */}
      <div className="flex items-center justify-between text-sm">
        <div className="text-slate-500">
          총 {filtered.length}종목 · {page + 1}/{totalPages} 페이지
        </div>
        <div className="flex gap-1">
          <button className="btn-ghost !py-1 !px-3" onClick={() => setPage(0)} disabled={page === 0}>« 처음</button>
          <button className="btn-ghost !py-1 !px-3" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>이전</button>
          <button className="btn-ghost !py-1 !px-3" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>다음</button>
          <button className="btn-ghost !py-1 !px-3" onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1}>마지막 »</button>
        </div>
      </div>

      <p className="text-xs text-slate-500 leading-relaxed">
        ※ 기관·개인·외국인 순매매 및 외국인 보유율은 KRX 전용 데이터로, 현재 시세 소스(Yahoo Finance)에서 제공되지 않아 표시하지 않습니다.
        PER·PBR·EPS·시가총액은 Yahoo 제공 값이며 실시간이 아닐 수 있습니다.
      </p>
    </div>
  );
}
