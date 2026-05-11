import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = join(__dirname, "..");

await build({
  absWorkingDir: extRoot,
  entryPoints: [join(extRoot, "dist", "extension.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(extRoot, "dist", "extension.bundled.js"),
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info"
});
