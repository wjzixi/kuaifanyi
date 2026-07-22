const esbuild = require("esbuild");
const process = require("process");

const prod = process.argv.includes("production");

const options = {
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  target: "es2020",
  platform: "browser",
  outfile: "main.js",
  minify: prod,
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
