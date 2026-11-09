// Parses every .cnc under a folder and prints a summary line per file.
// Usage: node scripts/check-parse.ts ["../chpu-driver/БРЕНД АРДЕКО"] [--svg out-dir]
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { gcodePreviewSvg, parseGcode, parseProgramName } from "../convex/lib/parseGcode.ts";

const args = process.argv.slice(2);
const svgAt = args.indexOf("--svg");
const svgDir = svgAt >= 0 ? args[svgAt + 1] : undefined;
const root = args.find((arg, i) => !arg.startsWith("--") && i !== svgAt + 1) ?? "../chpu-driver/БРЕНД АРДЕКО";

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(cnc|nc)$/i.test(name)) yield path;
  }
}

let count = 0;
let problems = 0;
if (svgDir) mkdirSync(svgDir, { recursive: true });
for (const path of files(root)) {
  const text = readFileSync(path, "latin1");
  const stats = parseGcode(text);
  const name = parseProgramName(basename(path), relative(root, path));
  const b = stats.bounds;
  const size = b ? `${Math.round(b.maxX - b.minX)}x${Math.round(b.maxY - b.minY)} z${b.minZ}` : "—";
  const tools = stats.tools.map((t) => `T${t.tool}@${t.rpm ?? "?"}:${Math.round(t.cutMm)}мм`).join(" ");
  const minutes = (stats.estimatedSec / 60).toFixed(1);
  console.log(
    `${relative(root, path)} | строк ${stats.lines} | ${size} | рез ${Math.round(stats.cutMm)} мм, холостые ${Math.round(stats.rapidMm)} мм | ~${minutes} мин | ${tools} | ${name.brand}/${name.kind}/${name.side ?? "-"}/${name.widthMm ?? "-"}/${name.thicknessMm ?? "-"}${stats.warnings.length ? ` | ВНИМАНИЕ: ${stats.warnings.join("; ")}` : ""}`,
  );
  if (stats.warnings.length) problems += 1;
  if (svgDir) writeFileSync(join(svgDir, basename(path) + ".svg"), gcodePreviewSvg(text));
  count += 1;
}
console.log(`Файлов: ${count}, с замечаниями: ${problems}`);
