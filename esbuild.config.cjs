const esbuild = require("esbuild");
const process = require("process");

const prod = process.argv.includes("production");

const options = {
  entryPoints: ["main.ts"],
  bundle: true,
  external: [
    "obsidian", "electron", "crypto", "fs", "path", "process",
    // ws 包（Edge TTS）依赖的 Node 内置模块，由 Electron nodeIntegration 提供
    "net", "tls", "http", "https", "stream", "zlib", "events", "url", "util", "buffer",
    "bufferutil", "utf-8-validate",
  ],
  mainFields: ["main"], // 绕开 ws 的 browser 存根（Electron 有 nodeIntegration，走 Node 实现）
  alias: { ws: require.resolve("ws") }, // 强制 ws 解析到 Node 实现（其 exports/browser 条件是抛错存根）
  format: "cjs",
  target: "es2020",
  platform: "browser",
  outfile: "main.js",
  minify: prod,
  keepNames: true,
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  logLevel: "info",
};

if (prod) {
  esbuild.build(options).catch(() => process.exit(1));
} else {
  // dev 模式：watch 自动重编
  esbuild.context(options).then((ctx) => {
    ctx.watch();
    console.log("Watching for changes...");
  }).catch(() => process.exit(1));
}
