// Runs casparser under Pyodide off the add-on's UI thread. parser.ts starts this file as a
// classic Worker from a blob URL: the sandbox's CSP blocks fetch(), but
// allows blob: scripts, dynamic import() of them, and WebAssembly.

const ORIGIN = "https://runtime.invalid/";

let pyodide;

async function boot({ files, wasmParts, wheels, pythonFiles }) {
  files["pyodide.asm.wasm"] = new Blob(wasmParts.map((part) => files[part]));
  // Pyodide fetches its files by URL; serve them from the packaged Blobs instead.
  self.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const name = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    if (!files[name]) throw new TypeError(`Not packaged with the add-on: ${name}`);
    const type = name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
    return new Response(files[name], { headers: { "Content-Type": type } });
  };
  const moduleUrl = (name) => URL.createObjectURL(new Blob([files[name]], { type: "text/javascript" }));
  const { loadPyodide } = await import(moduleUrl("pyodide.mjs"));
  const { default: createPyodideModule } = await import(moduleUrl("pyodide.asm.mjs"));
  const quiet = () => {};
  const py = await loadPyodide({ indexURL: ORIGIN, createPyodideModule, stdout: quiet, stderr: quiet });
  await py.loadPackage(
    wheels.map((wheel) => ORIGIN + wheel),
    { checkIntegrity: false, messageCallback: quiet, errorCallback: quiet },
  );
  py.FS.mkdirTree("/addon");
  for (const [name, source] of Object.entries(pythonFiles)) py.FS.writeFile(`/addon/${name}`, source);
  py.runPython("import sys; sys.path.insert(0, '/addon')");
  return py.pyimport("cas_parse").parse;
}

self.onmessage = async ({ data }) => {
  if (data.type === "boot") {
    pyodide = boot(data);
    pyodide.then(
      () => postMessage({ type: "ready" }),
      (error) => postMessage({ type: "failed", message: String(error?.message ?? error) }),
    );
    return;
  }
  const { id, pdf, password } = data;
  try {
    const parse = await pyodide;
    postMessage({ id, json: parse(new Uint8Array(pdf), password) });
  } catch (error) {
    // Python exception messages can contain extracted statement data.
    postMessage({ id, errorType: error?.type ?? "Error" });
  }
};
