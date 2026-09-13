import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const shared = resolve(__dirname, "src/shared");

// main/preload 는 CJS 로 번들된다. 두 AI SDK 는 ESM 전용이라 externalizeDepsPlugin 으로
// 번들 밖에 두고, 실제 로드는 src/main/esm.ts 의 importEsm(new Function) 으로 한다.
// (rollup 이 CJS 출력에서 import() 를 require 로 바꾸는 것을 피하기 위함)
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@shared": shared,
        "@renderer": resolve(__dirname, "src/renderer/src"),
      },
    },
  },
});
