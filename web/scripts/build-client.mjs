// Bundles client/app.ts into public/app.js and copies the self-hosted fonts.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

await build({
  entryPoints: ["client/app.ts"],
  outfile: "public/app.js",
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2022"],
  logLevel: "warning",
});

// Atkinson Hyperlegible Next as one variable font (weights 200 to 800), plus Mono for code.
const fonts = [
  ["@fontsource-variable/atkinson-hyperlegible-next", "atkinson-hyperlegible-next", ["latin-wght-normal", "latin-wght-italic", "latin-ext-wght-normal"]],
  ["@fontsource/atkinson-hyperlegible-mono", "atkinson-hyperlegible-mono", ["latin-400-normal"]],
];
fs.rmSync("public/fonts", { recursive: true, force: true });
fs.mkdirSync("public/fonts", { recursive: true });
for (const [pkg, family, files] of fonts) {
  for (const f of files) {
    const name = `${family}-${f}.woff2`;
    fs.copyFileSync(path.join("node_modules", pkg, "files", name), path.join("public/fonts", name));
  }
}
console.log("client built");
