// Runs casparser's own tests under Pyodide in Node, on the add-on's runtime and stub.
// casparser's sdist has no tests, so they come from its git tag for the bundled version.
// Its end-to-end tests need casparser's encrypted statements and skip themselves.
// Usage: pnpm runtime && node tests/casparser-tests.mjs [pytest arguments]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadRuntime, runtime } from "./runtime.mjs";

// What the add-on leaves out, so these tests can't pass with it.
const IGNORE = {
  "tests/casparser/test_cli.py": "casparser's command line, which needs rich's Markdown support",
};
const DESELECT = {
  "tests/test_demat_units.py::TestISINSearchFallback::test_direct_isin_fallback": "casparser-isin's database",
  "tests/test_demat_units.py::TestISINSearchFallback::test_direct_isin_fallback_unknown_isin": "casparser-isin's database",
  "tests/test_demat_units.py::TestBatchISINMetadata::test_resolves_known_isins": "casparser-isin's database",
  "tests/test_demat_units.py::TestBatchEquitySymbols::test_resolves_symbols": "casparser-isin's ISINDb",
  "tests/test_demat_units.py::TestEnrichDematEquities::test_enriches_equity_symbol": "casparser-isin's ISINDb",
  "tests/test_helpers.py::TestISINSearch::test_kfintech_lookup": "casparser-isin's database",
};

const version = runtime.wheels.find((wheel) => wheel.startsWith("casparser-")).split("-")[1];
const source = `.cache/casparser-${version}`;
if (!existsSync(source)) {
  // Leave out the casparser/ package, so the tests import the bundled wheel.
  const git = (...args) => execFileSync("git", args, { stdio: "inherit" });
  git("clone", "--quiet", "--depth=1", "--sparse", `--branch=v${version}`, "https://github.com/codereverser/casparser", source);
  git("-C", source, "sparse-checkout", "set", "--no-cone", "/*", "!/casparser/");
}

const py = await loadRuntime({ stdout: console.log, stderr: console.error });
// click: the end-to-end test modules import click.testing before skipping. packaging: pytest's minversion check.
await py.loadPackage(["pytest", "packaging", "click"], { messageCallback: () => {} });
py.mountNodeFS("/casparser", resolve(source));
const args = [
  "-p", "no:cacheprovider", "-o", "addopts=", "-rfE",
  ...Object.keys(IGNORE).map((path) => `--ignore=${path}`),
  ...Object.keys(DESELECT).map((id) => `--deselect=${id}`),
  ...process.argv.slice(2),
];
py.globals.set("args", py.toPy(args));
const exitCode = py.runPython(`
import os, pytest, casparser
assert casparser.__file__.startswith("/lib/"), casparser.__file__
os.chdir("/casparser")
int(pytest.main(list(args)))
`);
process.exit(Number(exitCode));
