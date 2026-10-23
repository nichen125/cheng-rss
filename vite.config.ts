import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// 前端构建。
//
// outDir 指到 dist/client —— pack-client-zip.mjs 会把这个目录打成 zip
// 供 SEA 内嵌（PLAN §3.4）。资源全部内联，不依赖外部 CDN。

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/client'),
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/client'),
    emptyOutDir: true,
    // 前端要内嵌进二进制，体积直接影响二进制大小。
    // 但压缩交给 zip（pack-client-zip），这里保持可读便于排查。
    minify: 'esbuild',
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        // 单 chunk，避免 SEA 内嵌时的相对路径问题
        manualChunks: undefined,
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 开发时把 API 转发到后端，避免跨域
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
