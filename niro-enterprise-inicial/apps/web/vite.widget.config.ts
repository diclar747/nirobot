import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  build: {
    outDir: 'public',
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, 'src/widget/main.ts'),
      name: 'NiroWidgetLib',
      formats: ['iife'],
      fileName: () => 'widget.js'
    },
    rollupOptions: {
      output: { extend: true }
    }
  }
});
