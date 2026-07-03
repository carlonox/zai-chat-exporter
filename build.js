const esbuild = require("esbuild");
const fs = require("fs");

if (fs.existsSync("dist")) {
  fs.rmSync("dist", { recursive: true, force: true });
}
fs.mkdirSync("dist");
fs.mkdirSync("dist/select");

const sharedConfig = {
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["chrome58", "firefox57", "edge79"],
  sourcemap: false,
  minify: true,
  external: ["chrome"],
};

async function build() {
  try {
    await esbuild.build({ ...sharedConfig, entryPoints: ["src/popup/popup.js"], outfile: "dist/popup.js" });
    await esbuild.build({ ...sharedConfig, entryPoints: ["src/content/content.js"], outfile: "dist/content.js" });
    await esbuild.build({ ...sharedConfig, entryPoints: ["src/background/background.js"], outfile: "dist/background.js" });
    await esbuild.build({ ...sharedConfig, entryPoints: ["src/select/select.js"], outfile: "dist/select/select.js" });

    var copyFiles = [
      { s: "src/popup/popup.html", d: "dist/popup.html" },
      { s: "src/popup/popup.css", d: "dist/popup.css" },
      { s: "src/content/content.css", d: "dist/content.css" },
      { s: "src/select/select.html", d: "dist/select/select.html" },
      { s: "src/select/select.css", d: "dist/select/select.css" },
    ];
    for (let i = 0; i < copyFiles.length; i++) {
      if (fs.existsSync(copyFiles[i].s)) { fs.copyFileSync(copyFiles[i].s, copyFiles[i].d); }
    }

    if (fs.existsSync("src/icons")) fs.cpSync("src/icons", "dist/icons", { recursive: true });
    if (fs.existsSync("src/manifest.firefox.json")) fs.copyFileSync("src/manifest.firefox.json", "dist/manifest.json");
    if (fs.existsSync("src/manifest.edge.json")) fs.copyFileSync("src/manifest.edge.json", "dist/manifest.edge.json");

    console.log("Build complete! Files are in the dist folder.");
    console.log("Firefox: manifest.json (from manifest.firefox.json)");
    console.log("Edge/Chrome: manifest.edge.json (rename to manifest.json to test)");
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}
build();
