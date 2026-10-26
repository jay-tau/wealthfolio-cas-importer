// Starts Pyodide in Node with what the add-on ships: the wheels in assets/runtime/ (run
// `pnpm runtime` first) and the add-on's Python files, importable from /addon.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPyodide } from "pyodide";

export const runtime = JSON.parse(await readFile("assets/runtime/files.json", "utf8"));

export async function loadRuntime({ stdout = () => {}, stderr = () => {} } = {}) {
  const py = await loadPyodide({ stdout, stderr });
  await py.loadPackage(
    runtime.wheels.map((wheel) => resolve("assets/runtime", wheel)),
    { checkIntegrity: false, messageCallback: () => {} },
  );
  py.FS.mkdirTree("/addon");
  for (const name of ["cas_parse.py", "casparser_isin.py"]) {
    py.FS.writeFile(`/addon/${name}`, await readFile(`src/cas/${name}`, "utf8"));
  }
  py.runPython("import sys; sys.path.insert(0, '/addon')");
  return py;
}
