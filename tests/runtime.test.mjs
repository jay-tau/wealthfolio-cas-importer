// Checks the bundled runtime against the casparser it ships, so that a bump needing a wheel the
// add-on doesn't bundle, or a casparser_isin method the stub lacks, fails here.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
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
    ...runtime.wheels,
  ]) {
    assert.ok(notices.includes(expected), `THIRD_PARTY_NOTICES.md doesn't mention "${expected}"`);
  }
});
