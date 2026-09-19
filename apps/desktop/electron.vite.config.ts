import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * @xfb/shared 是 workspace 内的 TypeScript 源码包，没有构建产物。
 * 默认会被 externalizeDepsPlugin 当成外部依赖排除掉，
 * 运行时 Electron 就会直接 require 到 .ts 文件而报错，
 * 所以必须显式排除，交给 vite 一起打包。
 */
const bundledWorkspaceDeps = ['@xfb/shared'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspaceDeps })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspaceDeps })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          pet: resolve(__dirname, 'src/renderer/pet.html'),
          input: resolve(__dirname, 'src/renderer/input.html'),
          panel: resolve(__dirname, 'src/renderer/panel.html'),
          basket: resolve(__dirname, 'src/renderer/basket.html'),
        },
      },
    },
  },
});
