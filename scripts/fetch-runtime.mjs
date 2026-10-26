// Fills assets/runtime/ with the Python runtime the add-on runs casparser on:
// Pyodide from node_modules (pinned in package.json), the Pyodide-built wheels named in
// runtime.json, and the PyPI wheels pinned in runtime-requirements.txt.
// Pyodide's wheels are checked against its pyodide-lock.json, the PyPI ones against the
// SHA-256 hashes pinned next to them. Downloads are cached in .cache/runtime/.
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
const requirements = parseRequirements(await readFile("runtime-requirements.txt", "utf8"));
const pyodideDir = dirname(createRequire(import.meta.url).resolve("pyodide/package.json"));
const { version: pyodideVersion } = JSON.parse(await readFile(join(pyodideDir, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(pyodideDir, "pyodide-lock.json"), "utf8"));
const cdn = `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/`;

// Wheel tags Pyodide can load: pure Python, or built for its ABI.
const [major, minor] = lock.info.python.split(".");
const interpreter = `cp${major}${minor}`;
const platform = `pyemscripten_${lock.info.abi_version}_${lock.info.arch}`;
const platforms = new Set([
  platform, `pyodide_${lock.info.abi_version}_${lock.info.arch}`, `${lock.info.platform}_${lock.info.arch}`,
]);
const pythonAbis = new Set([`${interpreter}-${interpreter}`, `${interpreter}-none`, `py${major}-none`]);
for (let version = 0; version <= Number(minor); version++) {
  pythonAbis.add(`py${major}${version}-none`);
  if (version >= 2) pythonAbis.add(`cp${major}${version}-abi3`);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function parseRequirements(text) {
  return text
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const [spec, ...options] = line.split(/\s+/);
      const pin = spec.match(/^([A-Za-z0-9._-]+)==([A-Za-z0-9.+!-]+)$/);
      const hashes = options.map((option) => option.match(/^--hash=sha256:([0-9a-f]{64})$/)?.[1]);
      if (!pin || !hashes.length || hashes.includes(undefined)) {
        throw new Error(`runtime-requirements.txt: pin "${line}" as name==version with --hash=sha256: options`);
      }
      return { name: pin[1], version: pin[2], hashes };
    });
}

function wheelRank(file) {
  if (!file.endsWith(".whl")) return 0;
  const parts = file.slice(0, -".whl".length).split("-");
  if (parts.length < 5) return 0;
  const [python, abi, plat] = parts.slice(-3).map((tag) => tag.split("."));
  let rank = 0;
  for (const py of python) {
    for (const tag of abi) {
      if (!pythonAbis.has(`${py}-${tag}`)) continue;
      if (plat.some((value) => platforms.has(value))) return 2;
      if (tag === "none" && plat.includes("any")) rank = 1;
    }
  }
  return rank;
}

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

async function pypiWheel({ name, version, hashes }) {
  // Cache the release metadata too, so offline builds make the same wheel choice.
  // Changed pins get fresh metadata, even if the version stays the same.
  const metadata = join(CACHE, `${name}-${version}-${sha256(hashes.join("\n"))}.json`);
  let urls;
  if (existsSync(metadata)) {
    urls = JSON.parse(await readFile(metadata, "utf8"));
  } else {
    const res = await fetch(`https://pypi.org/pypi/${name}/${version}/json`);
    if (!res.ok) throw new Error(`PyPI ${name} ${version}: HTTP ${res.status}`);
    urls = (await res.json()).urls;
    await writeFile(metadata, JSON.stringify(urls));
  }
  // Prefer a wheel built for Pyodide over a pure-Python one.
  const wheels = urls.filter((url) => wheelRank(url.filename));
  const wheel = wheels.sort((a, b) => wheelRank(b.filename) - wheelRank(a.filename))[0];
  if (!wheel) {
    throw new Error(`${name} ${version} has no wheel Pyodide ${pyodideVersion} can load (pure Python or ${platform})`);
  }
  if (!hashes.includes(wheel.digests.sha256)) {
    throw new Error(`${wheel.filename}: SHA-256 ${wheel.digests.sha256} isn't pinned in runtime-requirements.txt`);
  }
  return { file: wheel.filename, bytes: await download(wheel.filename, wheel.url, wheel.digests.sha256) };
}

// Start clean so files dropped from the pins don't linger in the package.
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
for (const name of pins.pyodidePackages) {
  const pkg = lock.packages[name];
  if (!pkg) throw new Error(`${name} is not in Pyodide ${pyodideVersion}'s pyodide-lock.json`);
  await writeFile(join(OUT, pkg.file_name), await download(pkg.file_name, cdn + pkg.file_name, pkg.sha256));
  wheels.push(pkg.file_name);
}
for (const requirement of requirements) {
  const { file, bytes } = await pypiWheel(requirement);
  await writeFile(join(OUT, file), bytes);
  wheels.push(file);
}

// Not manifest.json: Wealthfolio takes any file of that name in the package for the add-on manifest.
const files = { pyodide: pyodideVersion, files: pyodideFiles, wasmParts, wheels };
await writeFile(join(OUT, "files.json"), JSON.stringify(files, null, 2) + "\n");
console.log(`assets/runtime: Pyodide ${pyodideVersion}, ${wasmParts.length} wasm parts, ${wheels.length} wheels`);
