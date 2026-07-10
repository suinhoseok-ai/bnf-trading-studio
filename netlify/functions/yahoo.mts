// Yahoo Finance 프록시 함수 (프로덕션 CORS 우회)
// /api/yahoo/* → https://query1.finance.yahoo.com/*
export default async (req: Request) => {
  const url = new URL(req.url);
  const upstreamPath = url.pathname.replace(/^\/(\.netlify\/functions\/yahoo|api\/yahoo)/, '');
  const upstream = `https://query1.finance.yahoo.com${upstreamPath}${url.search}`;

  try {
    const res = await fetch(upstream, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BNFStudio/1.0)' },
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
