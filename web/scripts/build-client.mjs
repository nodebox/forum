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

const fonts = [
  ["atkinson-hyperlegible-next", ["latin-400-normal", "latin-400-italic", "latin-700-normal", "latin-ext-400-normal", "latin-ext-700-normal"]],
  ["atkinson-hyperlegible-mono", ["latin-400-normal"]],
];
fs.mkdirSync("public/fonts", { recursive: true });
for (const [family, files] of fonts) {
  for (const f of files) {
    const name = `${family}-${f}.woff2`;
    fs.copyFileSync(path.join("node_modules/@fontsource", family, "files", name), path.join("public/fonts", name));
  }
}
console.log("client built");
