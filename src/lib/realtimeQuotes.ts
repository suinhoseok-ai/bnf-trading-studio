// ===== 실시간 시세 (KIS 거래소 직접 조회) =====
// Yahoo는 15~20분 지연이라, 로그인 + KIS 연결된 사용자에 한해 거래소 실시간 시세로 덮어쓴다.
// 브라우저가 종목을 소량 배치로 순차 요청하고, 서버(broker.mts 'quotes')가 KIS 초당 제한에
// 맞춰 호출 간 지연을 둔다. 전체 유니버스도 조회 가능하나 (모의투자는) 시간이 걸린다.
import { supabase } from './supabase';

export interface KisQuote {
  symbol: string;
  price: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  volume: number;
}

// 서버가 요청당 최대 6개까지만 처리하므로 배치 크기를 맞춘다.
const BATCH = 6;

/**
 * 주어진 심볼들의 실시간 시세를 배치로 순차 조회한다.
 * @param onProgress 각 배치 완료 시 (조회완료 수, 전체 수, 이번 배치 시세) 콜백 — 진행형 렌더링용
 * @returns symbol → KisQuote 맵 (조회 실패/가격 0 종목은 제외)
 */
export async function fetchKisQuotes(
  symbols: string[],
  onProgress?: (done: number, total: number, quotes: KisQuote[]) => void,
): Promise<Record<string, KisQuote>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('로그인이 필요합니다.');

  const uniq = [...new Set(symbols)];
  const result: Record<string, KisQuote> = {};
  let done = 0;

  for (let i = 0; i < uniq.length; i += BATCH) {
    const batch = uniq.slice(i, i + BATCH);
    let good: KisQuote[] = [];
    try {
      const res = await fetch('/api/broker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'quotes', accessToken: token, symbols: batch }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      const raw = (Array.isArray(j.quotes) ? j.quotes : []) as (KisQuote & { error?: string })[];
      good = raw.filter((q) => !q.error && q.price > 0);
      for (const q of good) result[q.symbol] = q;
    } catch (e) {
      // 첫 배치부터 실패(미연결·인증 등)면 상위로 전달, 그 외 배치 실패는 폴백 유지
      if (i === 0) throw e;
    }
    done += batch.length;
    onProgress?.(done, uniq.length, good);
  }

  return result;
}
