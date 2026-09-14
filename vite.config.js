import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // GitHub Pages 서브경로(jjabroin.github.io/humanfall-p2p/) 대응
  server: { port: 5173, host: true },
  build: { target: 'esnext' },
});
