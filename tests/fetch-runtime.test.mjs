import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

// Run the whole downloader with an in-memory filesystem and PyPI, without network or files.
const source = (await readFile("scripts/fetch-runtime.mjs", "utf8"))
  .replace(/^import .+;\n/gm, "")
  .replaceAll("import.meta.url", JSON.stringify(import.meta.url));
const platform = "pyemscripten_2026_0_wasm32";
const pure = "demo-1.0-py3-none-any.whl";
const native = `demo-1.0-py3-none-${platform}.whl`;
const digest = (file) => createHash("sha256").update(file).digest("hex");
const urls = [pure, native].map((filename) => ({
  filename, url: `https://files.test/${filename}`, digests: { sha256: digest(filename) },
}));

function fixture() {
  const files = new Map([
    ["runtime.json", JSON.stringify({ pyodidePackages: [] })],
    ["runtime-requirements.txt", `demo==1.0 \\\n    --hash=sha256:${digest(pure)} \\\n    --hash=sha256:${digest(native)}\n`],
    ["/pyodide/package.json", JSON.stringify({ version: "314.0.7" })],
    ["/pyodide/pyodide-lock.json", JSON.stringify({
      info: { python: "3.14.2", abi_version: "2026_0", arch: "wasm32", platform: "emscripten_5_0_3" }, packages: {},
    })],
    ...["pyodide.mjs", "pyodide.asm.mjs", "python_stdlib.zip", "pyodide.asm.wasm"]
      .map((name) => [`/pyodide/${name}`, Buffer.from(name)]),
  ]);
  return files;
}

async function run(files, online = true, release = urls) {
  await vm.runInNewContext(`(async () => { ${source} })()`, {
    Buffer, createHash, dirname, join,
    console: { log() {} },
    createRequire: () => ({ resolve: () => "/pyodide/package.json" }),
    existsSync: (path) => files.has(path),
    mkdir: async () => {},
    rm: async (path) => {
      for (const name of files.keys()) if (name.startsWith(`${path}/`)) files.delete(name);
    },
    readFile: async (path, encoding) => {
      assert.ok(files.has(path), `missing fixture file: ${path}`);
      const bytes = Buffer.from(files.get(path));
      return encoding ? bytes.toString(encoding) : bytes;
    },
    writeFile: async (path, bytes) => files.set(path, bytes),
    fetch: async (url) => {
      assert.ok(online, `unexpected offline request: ${url}`);
      if (url === "https://pypi.org/pypi/demo/1.0/json") return { ok: true, json: async () => ({ urls: release }) };
      const wheel = release.find((wheel) => wheel.url === url);
      assert.ok(wheel, `unexpected request: ${url}`);
      return { ok: true, arrayBuffer: async () => Buffer.from(wheel.filename) };
    },
  });
  return JSON.parse(files.get("assets/runtime/files.json")).wheels;
}

test("runtime selects the same pinned wheel with an empty, partial or full cache and offline", async () => {
  for (const cached of [[], [pure], [pure, native]]) {
    const files = fixture();
    for (const file of cached) files.set(`.cache/runtime/${file}`, Buffer.from(file));
    assert.deepEqual(await run(files), [native]);
    assert.deepEqual(await run(files, false), [native]);
  }
});

test("runtime rejects an unpinned wheel and a release without a matching ABI", async () => {
  const wrongHash = [{ ...urls[1], digests: { sha256: "0".repeat(64) } }];
  await assert.rejects(run(fixture(), true, wrongHash), /isn't pinned/);
  const wrongAbi = [{ ...urls[1], filename: native.replace("2026_0", "2025_0") }];
  await assert.rejects(run(fixture(), true, wrongAbi), /has no wheel Pyodide/);
});

test("runtime refreshes metadata when hashes change without a version change", async () => {
  const files = fixture();
  await run(files);
  files.set("runtime-requirements.txt", `demo==1.0 --hash=sha256:${digest(pure)}\n`);
  await assert.rejects(run(files), /isn't pinned/);
});

test("runtime accepts compatible Python and Pyodide tags, and rejects incompatible pairs", async () => {
  for (const [tag, compatible] of [
    ["py313-none-any", true],
    [`cp313-abi3-${platform}`, true],
    ["py3-none-pyodide_2026_0_wasm32", true],
    ["cp314-cp314-emscripten_5_0_3_wasm32", true],
    ["py315-none-any", false],
    [`cp313-cp314-${platform}`, false],
    ["cp314-abi3-any", false],
    ["py3-none-pyodide_2025_0_wasm32", false],
  ]) {
    const filename = `demo-1.0-${tag}.whl`;
    const wheel = { filename, url: `https://files.test/${filename}`, digests: { sha256: digest(filename) } };
    const files = fixture();
    files.set("runtime-requirements.txt", `demo==1.0 --hash=sha256:${digest(filename)}\n`);
    if (compatible) assert.deepEqual(await run(files, true, [wheel]), [filename]);
    else await assert.rejects(run(files, true, [wheel]), /has no wheel Pyodide/, tag);
  }
});
