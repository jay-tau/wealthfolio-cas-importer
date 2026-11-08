// Checks the bundled runtime against the casparser it ships, so that a bump needing a wheel the
// add-on doesn't bundle, or a casparser_isin method the stub lacks, fails here.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { loadRuntime, runtime } from "./runtime.mjs";

// casparser requirements the add-on leaves out on purpose.
const UNBUNDLED = {
  "casparser-isin": "src/cas/casparser_isin.py stands in for its 49 MB database",
  click: "casparser's command line only",
  colorama: "casparser's command line only",
  rich: "casparser's command line only",
};

async function loadChecks() {
  const py = await loadRuntime();
  py.FS.writeFile("/addon/check_runtime.py", await readFile("tests/check_runtime.py", "utf8"));
  return { py, check: py.pyimport("check_runtime") };
}

test("casparser imports only modules the add-on bundles", async () => {
  const { check } = await loadChecks();
  assert.deepEqual(check.missing_imports().toJs(), []);
});

test("the casparser_isin stub has every method casparser calls", async () => {
  const { py, check } = await loadChecks();
  assert.deepEqual(check.stub_gaps().toJs(), []);
  py.runPython(`
import ast, check_runtime
original_modules = check_runtime._modules
try:
    for body, broken in [
        ("db.direct_isin_lookup('A')", False),
        ("db.direct_isin_lookup('A', 'B')", True),
        ("db.missing_method('A')", True),
        ("db.direct_isin_lookup(*('A', 'B'))", True),
        ("db.direct_isin_lookup(**{'wrong': 'A'})", True),
        ("lookup = db.direct_isin_lookup; lookup('A', 'B')", True),
    ]:
        tree = ast.parse("from casparser_isin import MFISINDb\\nwith MFISINDb() as db:\\n    " + body)
        check_runtime._modules = lambda: [("casparser/probe.py", tree)]
        gaps = check_runtime.stub_gaps()
        assert bool(gaps) == broken, (body, gaps)
finally:
    check_runtime._modules = original_modules
`);
});

test("the bundled wheels meet each other's requirements", async () => {
  // A runtime of its own: packaging, loaded for this check, would hide a missing import above.
  const { py, check } = await loadChecks();
  await py.loadPackage("packaging", { messageCallback: () => {} });
  const bundled = runtime.wheels.map((wheel) => wheel.split("-")[0]);
  assert.deepEqual(check.unmet_requirements(bundled, Object.keys(UNBUNDLED)).toJs(), []);
});

test("THIRD_PARTY_NOTICES.md names the bundled versions", async () => {
  const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
  const lock = JSON.parse(await readFile("assets/runtime/pyodide-lock.json", "utf8"));
  const emscripten = lock.info.platform.replace(/^emscripten_/, "").replaceAll("_", ".");
  for (const expected of [
    `the Pyodide ${runtime.pyodide} runtime`,
    `CPython interpreter and standard library | ${lock.info.python} |`,
    `Emscripten JS runtime and C system libraries | ${emscripten} |`,
  ]) {
    assert.ok(notices.includes(expected), `THIRD_PARTY_NOTICES.md doesn't mention "${expected}"`);
  }
});

// A bundled wheel's file names, and its version.json files (pypdfium2_raw/ has PDFium's).
async function readWheel(file) {
  const names = [];
  const files = unzipSync(await readFile(join("assets/runtime", file)), {
    filter: ({ name }) => names.push(name) && name.endsWith("/version.json"),
  });
  return { file, names, files };
}

// What in THIRD_PARTY_NOTICES.md's "Python wheels" table doesn't match the bundled wheels: a
// wheel without a row, a Version cell, PDFium's version, or a "Full text" path that isn't in the
// row's wheel (or, under licenses/, in this repository). A "same wheel" row is the wheel above it.
async function wheelNoticeProblems(notices) {
  const problems = [];
  const lines = notices.split("\n").map((line) => line.trim());
  const start = lines.indexOf("## Python wheels");
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  const rows = start < 0 ? [] : lines.slice(start + 1, end < 0 ? undefined : end)
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) => line.split("|").slice(1).map((cell) => cell.trim()));
  const rowed = new Set();
  let wheel;
  let pdfium = false;
  for (const [component, version, , fullText = "", , shipsIn = ""] of rows) {
    const file = shipsIn.match(/^wheel `([^`]+)`$/)?.[1];
    if (file) {
      wheel = runtime.wheels.includes(file) ? await readWheel(file) : undefined;
      if (!wheel) {
        problems.push(`${component}: ${file} isn't bundled`);
        continue;
      }
      rowed.add(file);
      const expected = file.split("-")[1];
      if (version !== expected) problems.push(`${component}: Version is "${version}", ${file} is ${expected}`);
    } else if (!shipsIn.startsWith("same wheel") || !wheel) {
      problems.push(`${component}: ships in "${shipsIn}", which isn't a bundled wheel`);
      continue;
    }
    if (component.startsWith("PDFium ")) {
      pdfium = true;
      const json = wheel.files["pypdfium2_raw/version.json"];
      const v = json && JSON.parse(strFromU8(json));
      const expected = v ? `PDFium ${v.major}.${v.minor}.${v.build}.${v.patch}` : "in pypdfium2_raw/version.json";
      if (version !== expected) problems.push(`PDFium: Version is "${version}", ${wheel.file} has ${expected}`);
    }
    const paths = [...fullText.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    if (!paths.length) problems.push(`${component}: "Full text" names no file`);
    for (const path of paths) {
      if (path.startsWith("licenses/")) {
        if (!existsSync(path)) problems.push(`${component}: ${path} doesn't exist`);
      } else if (!wheel.names.some((name) => (path.endsWith("/") ? name.startsWith(path) : name === path))) {
        problems.push(`${component}: ${path} isn't in ${wheel.file}`);
      }
    }
  }
  for (const file of runtime.wheels) {
    if (!rowed.has(file)) problems.push(`${file}: no row ships it`);
  }
  if (!pdfium && runtime.wheels.some((file) => file.startsWith("pypdfium2-"))) {
    problems.push("PDFium: no row");
  }
  return problems;
}

test("THIRD_PARTY_NOTICES.md's wheel rows match the bundled wheels", async () => {
  const notices = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
  assert.deepEqual(await wheelNoticeProblems(notices), []);
  assert.deepEqual(await wheelNoticeProblems(notices.replaceAll("| ", "|")), []);
  // A row left stale in one cell, or missing, fails.
  const oldDistInfo = (text) => text.replace(/-[^-/`]+\.dist-info\//, "-0.dist-info/");
  for (const [row, cell, edit] of [
    ["PDFium ", 1, () => "PDFium 156.0.8076.0"],
    ["PDFium ", 3, oldDistInfo],
    ["casparser", 1, () => "0"],
    ["casparser", 3, oldDistInfo],
    ["Rust crates ", 3, (text) => text.replace("licenses/", "licenses/0-")],
    ["casparser", null],
  ]) {
    const lines = notices.split("\n");
    const i = lines.findIndex((line) => line.split("|")[1]?.trim().startsWith(row));
    const cells = lines[i].split("|").slice(1);
    if (edit) cells[cell] = edit(cells[cell]);
    const changed = edit ? `|${cells.join("|")}` : "(removed)";
    lines.splice(i, 1, ...(edit ? [changed] : []));
    const problems = await wheelNoticeProblems(lines.join("\n"));
    assert.equal(problems.length, 1, `${changed}\n${problems.join("\n")}`);
  }
});
