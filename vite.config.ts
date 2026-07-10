import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 모드에서 텔레그램 발송(/api/telegram)을 처리하는 미들웨어
// (프로덕션에서는 netlify/functions/telegram 함수가 동일 경로를 처리)
function telegramDevProxy(): Plugin {
  return {
    name: 'telegram-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/telegram', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          try {
            const { botToken, chatId, text } = JSON.parse(body || '{}');
            const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
            });
            const data = await r.json().catch(() => ({}));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: data.ok === true, error: data.ok ? undefined : (data.description ?? `HTTP ${r.status}`) }));
          } catch (e) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });
    },
  };
}

// 개발 모드에서는 Yahoo Finance API를 Vite 프록시로 우회 (CORS 회피)
// 프로덕션(Netlify)에서는 netlify/functions/yahoo 함수가 동일 경로를 처리
export default defineConfig({
  plugins: [react(), telegramDevProxy()],
  server: {
    proxy: {
      '/api/yahoo': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      },
    },
  },
});
