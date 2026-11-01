import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";
import { test } from "node:test";
import { build } from "vite";

const [bundle] = await build({
  configFile: false,
  logLevel: "silent",
  build: { write: false, lib: { entry: "src/cas/parser.ts", formats: ["iife"], name: "parser" } },
});
const assets = { getBlob: async () => new Blob([JSON.stringify({ files: [], wasmParts: [], wheels: [] })]) };

// Looks up the timers when called, so the bundle sees node:test's mock timers.
const timers = { setTimeout: (...args) => setTimeout(...args), clearTimeout: (id) => clearTimeout(id) };

function createParser(source = assets, { starts = true } = {}) {
  let worker;
  class Worker {
    messages = [];
    terminated = false;
    constructor() { worker = this; }
    postMessage(message) {
      this.messages.push(message);
      if (message.type === "boot" && starts) queueMicrotask(() => this.onmessage({ data: { type: "ready" } }));
    }
    terminate() { this.terminated = true; }
  }
  const context = { Worker, Blob, URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} }, ...timers };
  vm.runInNewContext(bundle.output[0].code, context);
  return { parser: new context.parser.CasParser(source), worker };
}

test("Worker construction failure releases its blob URL", () => {
  let revoked;
  const error = new Error("Worker blocked");
  const context = {
    Worker: class { constructor() { throw error; } },
    Blob,
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: (url) => { revoked = url; } },
    ...timers,
  };
  vm.runInNewContext(bundle.output[0].code, context);
  assert.throws(() => new context.parser.CasParser(assets), error);
  assert.equal(revoked, "blob:test");
});

test("a fatal Worker error rejects the current parse and later requests", { timeout: 1000 }, async () => {
  const { parser, worker } = createParser();
  const pending = parser.parse(new ArrayBuffer(1), "test");
  const rejected = assert.rejects(pending, { kind: "runtime" });
  await setImmediate();
  worker.onerror({ message: "Worker stopped", preventDefault() {} });
  await rejected;
  assert.equal(parser.stopped, true);
  await assert.rejects(parser.parse(new ArrayBuffer(1), "test"), { kind: "runtime" });
  parser.dispose();
});

test("a parser that doesn't start in time stops and rejects its reads", { timeout: 1000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { parser, worker } = createParser(assets, { starts: false });
  const rejected = assert.rejects(parser.parse(new ArrayBuffer(1), "test"), {
    kind: "runtime",
    message: "The parser didn't start in time. Try reading the statement again.",
  });
  await setImmediate();
  assert.equal(parser.stopped, false);
  t.mock.timers.tick(119_999);
  assert.equal(parser.stopped, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(parser.stopped, true);
  assert.equal(worker.terminated, true);
  assert.equal(worker.messages.filter((message) => message.type === "parse").length, 0);
});

test("a read with no reply in time stops the parser", { timeout: 1000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { parser, worker } = createParser();
  const rejected = assert.rejects(parser.parse(new ArrayBuffer(1), "test"), {
    kind: "runtime",
    message: "The parser didn't finish reading this PDF in time. Try reading it again.",
  });
  await setImmediate();
  // Starting took no time off the read's own limit.
  t.mock.timers.tick(299_999);
  assert.equal(parser.stopped, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(parser.stopped, true);
  assert.equal(worker.terminated, true);
  await assert.rejects(parser.parse(new ArrayBuffer(1), "test"), { kind: "runtime" });
});

test("a reply in time keeps the parser running", { timeout: 1000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { parser, worker } = createParser();
  const parsed = parser.parse(new ArrayBuffer(1), "test");
  await setImmediate();
  t.mock.timers.tick(299_999);
  const { id } = worker.messages.find((message) => message.type === "parse");
  worker.onmessage({ data: { id, json: JSON.stringify({ file_type: "NSDL", accounts: [] }) } });
  await parsed;
  t.mock.timers.tick(600_000);
  assert.equal(parser.stopped, false);
  assert.equal(worker.terminated, false);
  parser.dispose();
  assert.equal(parser.stopped, true);
});

test("a fatal Python error stops the parser", { timeout: 1000 }, async () => {
  const { parser, worker } = createParser();
  const rejected = assert.rejects(parser.parse(new ArrayBuffer(1), "test"), {
    kind: "runtime",
    message: "The parser stopped. Try reading the statement again.",
  });
  await setImmediate();
  const { id } = worker.messages.find((message) => message.type === "parse");
  worker.onmessage({ data: { id, fatal: true } });
  await rejected;
  assert.equal(parser.stopped, true);
  assert.equal(worker.terminated, true);
});

test("a read that can't be posted leaves no timeout behind", { timeout: 1000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { parser, worker } = createParser();
  await setImmediate();
  worker.postMessage = (message, transfer) => {
    structuredClone(message, { transfer });
    worker.messages.push(message);
  };
  const pdf = new ArrayBuffer(1);
  structuredClone(pdf, { transfer: [pdf] });
  await assert.rejects(parser.parse(pdf, "test"), { name: "DataCloneError" });
  t.mock.timers.tick(300_000);
  assert.equal(parser.stopped, false);
  assert.equal(worker.terminated, false);
  const parsed = parser.parse(new ArrayBuffer(1), "test");
  await setImmediate();
  const { id } = worker.messages.find((message) => message.type === "parse");
  worker.onmessage({ data: { id, json: JSON.stringify({ file_type: "NSDL", accounts: [] }) } });
  await parsed;
  parser.dispose();
});

test("disposing during startup rejects requests and prevents late boot delivery", { timeout: 1000 }, async () => {
  let finishLoad;
  const { parser, worker } = createParser({ getBlob: () => new Promise((resolve) => { finishLoad = resolve; }) });
  const rejected = assert.rejects(parser.parse(new ArrayBuffer(1), "test"), { kind: "runtime" });
  parser.dispose();
  await rejected;
  finishLoad(await assets.getBlob());
  await setImmediate();
  assert.equal(worker.messages.length, 0);
  await assert.rejects(parser.parse(new ArrayBuffer(1), "test"), { kind: "runtime" });
});

test("disposing during a parse rejects its request", { timeout: 1000 }, async () => {
  const { parser } = createParser();
  const rejected = assert.rejects(parser.parse(new ArrayBuffer(1), "test"), { kind: "runtime" });
  await setImmediate();
  parser.dispose();
  await rejected;
});

async function reply(data) {
  const { parser, worker } = createParser();
  const parsed = parser.parse(new ArrayBuffer(1), "test");
  await setImmediate();
  const { id } = worker.messages.find((message) => message.type === "parse");
  worker.onmessage({ data: { id, json: JSON.stringify(data) } });
  return parsed.finally(() => parser.dispose());
}

for (const data of [
  { file_type: "CAMS", cas_type: "DETAILED" },
  { file_type: "KFINTECH", cas_type: "SUMMARY" },
  { file_type: "NSDL", accounts: [] },
  { file_type: "CDSL", accounts: [] },
]) {
  test(`reads ${data.cas_type ?? data.file_type} statements`, { timeout: 1000 }, async () => {
    // Parsed in the bundle's own realm, so compare plain copies.
    assert.deepEqual(JSON.parse(JSON.stringify(await reply(data))), data);
  });
}

test("rejects a CAMS statement that is neither detailed nor a summary", { timeout: 1000 }, async () => {
  await assert.rejects(reply({ file_type: "CAMS", cas_type: "UNKNOWN" }), { kind: "unsupported" });
});

test("parse errors do not put extracted data into the Worker reply", async () => {
  const source = await readFile("src/cas/worker.js", "utf8");
  const replies = [];
  const context = vm.createContext({ self: {}, postMessage: (reply) => replies.push(reply), Uint8Array });
  vm.runInContext(source, context);
  vm.runInContext('pyodide = Promise.resolve(() => { throw { type: "ParserError", message: "private-input@example.com ABCDE1234F" }; });', context);
  await context.self.onmessage({ data: { type: "parse", id: 7, pdf: new ArrayBuffer(1), password: "secret" } });
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), [{ id: 7, errorType: "ParserError" }]);
});

test("a fatal Pyodide error is reported as fatal, without its message", async () => {
  const source = await readFile("src/cas/worker.js", "utf8");
  const replies = [];
  const context = vm.createContext({ self: {}, postMessage: (reply) => replies.push(reply), Uint8Array });
  vm.runInContext(source, context);
  vm.runInContext('pyodide = Promise.resolve(() => { throw Object.assign(new Error("Unreachable code should not be executed"), { pyodide_fatal_error: true }); });', context);
  await context.self.onmessage({ data: { type: "parse", id: 8, pdf: new ArrayBuffer(1), password: "secret" } });
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), [{ id: 8, fatal: true }]);
});
