import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 모드에서는 Yahoo Finance API를 Vite 프록시로 우회 (CORS 회피)
// 프로덕션(Netlify)에서는 netlify/functions/yahoo 함수가 동일 경로를 처리
export default defineConfig({
  plugins: [react()],
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
