// Fills assets/runtime/ with the Python runtime the add-on runs casparser on:
// Pyodide from node_modules (pinned in package.json) and the wheels in runtime.json.
// Wheels Pyodide publishes are checked against its pyodide-lock.json, the others
// against the SHA-256 in runtime.json. Downloads are cached in .cache/runtime/.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const OUT = "assets/runtime";
const CACHE = ".cache/runtime";
// Wealthfolio rejects add-on files over 5 MiB; Pyodide's wasm is bigger, so it ships in parts.
const MAX_PART = 4 * 1024 * 1024;

const pins = JSON.parse(await readFile("runtime.json", "utf8"));
const pyodideDir = dirname(createRequire(import.meta.url).resolve("pyodide/package.json"));
const { version } = JSON.parse(await readFile(join(pyodideDir, "package.json"), "utf8"));
if (version !== pins.pyodide) {
  throw new Error(`node_modules has pyodide ${version}, runtime.json pins ${pins.pyodide}`);
}
const lock = JSON.parse(await readFile(join(pyodideDir, "pyodide-lock.json"), "utf8"));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function download(file, url, expected) {
  const cached = join(CACHE, file);
  if (existsSync(cached)) {
    const bytes = await readFile(cached);
    if (sha256(bytes) === expected) return bytes;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${file}: SHA-256 ${actual}, expected ${expected}`);
  await writeFile(cached, bytes);
  return bytes;
}

// Start clean so files dropped from runtime.json don't linger in the package.
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await mkdir(CACHE, { recursive: true });

const pyodideFiles = ["pyodide.mjs", "pyodide.asm.mjs", "python_stdlib.zip", "pyodide-lock.json"];
for (const file of pyodideFiles) {
  await writeFile(join(OUT, file), await readFile(join(pyodideDir, file)));
}

const wasm = await readFile(join(pyodideDir, "pyodide.asm.wasm"));
const wasmParts = [];
for (let start = 0; start < wasm.length; start += MAX_PART) {
  const part = `pyodide.asm.wasm.${wasmParts.length}`;
  await writeFile(join(OUT, part), wasm.subarray(start, start + MAX_PART));
  wasmParts.push(part);
}

const wheels = [];
for (const pin of pins.wheels) {
  let file = pin.file;
  let bytes;
  if (pin.lock) {
    const pkg = lock.packages[pin.lock];
    if (!pkg) throw new Error(`${pin.lock} is not in pyodide-lock.json`);
    file = pkg.file_name;
    bytes = await download(file, pins.pyodideCdn + file, pkg.sha256);
  } else {
    bytes = await download(file, pin.url, pin.sha256);
  }
  await writeFile(join(OUT, file), bytes);
  wheels.push(file);
}

// Not manifest.json: Wealthfolio takes any file of that name in the package for the add-on manifest.
const files = { pyodide: version, files: pyodideFiles, wasmParts, wheels };
await writeFile(join(OUT, "files.json"), JSON.stringify(files, null, 2) + "\n");
console.log(`assets/runtime: Pyodide ${version}, ${wasmParts.length} wasm parts, ${wheels.length} wheels`);
