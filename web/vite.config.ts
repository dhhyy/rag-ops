import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 서버(5173)에서도 /api 요청은 Rust 서버(4173)로 넘긴다. 운영에서는 Rust가 화면과 /api를 함께 내준다.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4173' } },
});
