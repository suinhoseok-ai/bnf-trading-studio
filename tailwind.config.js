/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#0b1220',
        panel: '#111a2e',
        edge: '#1f2b47',
        accent: '#3b82f6',
        up: '#ef4444',
        down: '#3b82f6',
        profit: '#22c55e',
      },
    },
  },
  plugins: [],
};
