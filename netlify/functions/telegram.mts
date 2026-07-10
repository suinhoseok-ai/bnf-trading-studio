// 텔레그램 발송 프록시 (POST /api/telegram)
// 브라우저 CORS 및 URL 노출을 피하기 위해 봇 토큰/텍스트를 body로 받아 서버에서 전송한다.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

export default async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  let botToken = '', chatId = '', text = '';
  try {
    const b = await req.json();
    botToken = b.botToken; chatId = b.chatId; text = b.text;
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }
  if (!botToken || !chatId || !text) return json({ ok: false, error: 'botToken/chatId/text 필요' }, 400);

  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const data = await r.json().catch(() => ({}));
    return json({ ok: data.ok === true, error: data.ok ? undefined : (data.description ?? `HTTP ${r.status}`) });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502);
  }
};
