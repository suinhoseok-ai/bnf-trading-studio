// Yahoo Finance 프록시 함수 (프로덕션 CORS 우회)
// /api/yahoo/* → https://query1.finance.yahoo.com/* (실패 시 query2로 1회 재시도)
const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

export default async (req: Request) => {
  const url = new URL(req.url);
  const upstreamPath = url.pathname.replace(/^\/(\.netlify\/functions\/yahoo|api\/yahoo)/, '');

  let lastRes: Response | null = null;
  let lastErr: unknown = null;
  for (const host of YAHOO_HOSTS) {
    try {
      const res = await fetch(`${host}${upstreamPath}${url.search}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BNFStudio/1.0)' },
      });
      if (res.ok) {
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      lastRes = res;
    } catch (e) {
      lastErr = e;
    }
  }

  if (lastRes) {
    const body = await lastRes.text();
    console.warn('[yahoo proxy] 모든 호스트 실패', lastRes.status, upstreamPath);
    return new Response(body, {
      status: lastRes.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
  console.warn('[yahoo proxy] 네트워크 오류', String(lastErr), upstreamPath);
  return new Response(JSON.stringify({ error: String(lastErr) }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  });
};
