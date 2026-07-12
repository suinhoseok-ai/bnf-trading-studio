/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 옅은 하늘색 라이트 테마
        base: '#eaf4ff',      // 페이지 배경
        panel: '#ffffff',     // 카드/사이드바 배경
        edge: '#cfe3f7',      // 테두리
        accent: '#2f7de0',    // 포인트 컬러 (하늘색)
        up: '#e0294b',        // 상승(빨강, 라이트 배경 대비 보정)
        down: '#2f7de0',      // 하락(파랑) — accent와 통일
        profit: '#1a9b56',    // 익절/수익(초록, 라이트 배경 대비 보정)
        ink: '#122b4d',       // 헤딩/본문 텍스트 (구 다크테마의 text-white 대체)
        // Tailwind 기본 slate 팔레트를 라이트 배경용으로 재정의.
        // 다크테마에서는 200(밝음)~600(어두움=거의 안 보임) 순으로 옅어졌던 위계를
        // 라이트 배경에서도 동일하게 유지하기 위해 밝기 순서를 반전시켰다:
        // 200(가장 진함=본문) → 600(가장 옅음=흐린/비활성 텍스트).
        slate: {
          200: '#1f3c63',
          300: '#34537f',
          400: '#5c7ba3',
          500: '#7796b8',
          600: '#a9c2dc',
        },
      },
    },
  },
  plugins: [],
};
