const esbuild = require("esbuild");
const process = require("process");
const fs = require("fs");
const path = require("path");

const prod = process.argv.includes("production");

// 拷贝 sql.js 运行时文件到输出目录
const sqljsDir = path.join(__dirname, "node_modules", "sql.js", "dist");
for (const f of ["sql-wasm.js", "sql-wasm.wasm"]) {
  const src = path.join(sqljsDir, f);
  const dst = path.join(__dirname, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log(`Copied ${f}`);
  }
}

const options = {
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "crypto", "fs", "path", "process", "sql.js", "./sql-wasm"],
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
