// casparser under Pyodide in Node, with the packaged wheels (run `pnpm runtime` first), the
// add-on's stub and entry point, on the made-up statements in tests/fixtures/.
// tests/browser/sandbox.mjs checks the same in browsers, inside Wealthfolio's sandbox.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { before, test } from "node:test";
import { loadPyodide } from "pyodide";

const PASSWORD = "ABCDE1234F";
let parse;

before(async () => {
  const runtime = JSON.parse(await readFile("assets/runtime/files.json", "utf8"));
  const quiet = () => {};
  const py = await loadPyodide({ stdout: quiet, stderr: quiet });
  await py.loadPackage(
    runtime.wheels.map((wheel) => resolve("assets/runtime", wheel)),
    { checkIntegrity: false, messageCallback: quiet },
  );
  py.FS.mkdirTree("/addon");
  for (const name of ["cas_parse.py", "casparser_isin.py"]) {
    py.FS.writeFile(`/addon/${name}`, await readFile(`src/cas/${name}`, "utf8"));
  }
  py.runPython("import sys; sys.path.insert(0, '/addon')");
  parse = py.pyimport("cas_parse").parse;
});

const fixture = async (name) => ({
  pdf: new Uint8Array(await readFile(`tests/fixtures/${name}.pdf`)),
  expected: JSON.parse(await readFile(`tests/fixtures/${name}.json`, "utf8")),
});

test("parses every row of the made-up statement", async () => {
  const { pdf, expected } = await fixture("made-up-cas");
  const data = JSON.parse(parse(pdf, PASSWORD));
  assert.deepEqual(data, expected);
  assert.deepEqual(data.parse_warnings, []);
});

test("reports a missing row as a balance mismatch", async () => {
  const { pdf, expected } = await fixture("made-up-cas-mismatch");
  const data = JSON.parse(parse(pdf, PASSWORD));
  assert.deepEqual(data, expected);
  assert.equal(data.parse_warnings.length, 1);
});

test("rejects a wrong password", async () => {
  const { pdf } = await fixture("made-up-cas");
  assert.throws(() => parse(pdf, "WRONGPASS1"), { type: "IncorrectPasswordError" });
});
