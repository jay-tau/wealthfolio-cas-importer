// The Wealthfolio functions src/ uses, checked against the permissions manifest.json declares.
// Wealthfolio 3.13.0 refuses a call the manifest doesn't declare with AddonPermissionDenied
// (createPermissionGuard in apps/frontend/src/addons/type-bridge.ts), and the browser test's fake
// host grants everything, so this is the only test that sees a missing permission. TypeScript's
// checker finds the uses: a call through a `Pick<AddonContext["api"]["activities"], …>` parameter
// resolves to the SDK's ActivitiesAPI as `ctx.api.activities.create` does.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { test } from "node:test";
import { PERMISSION_CATEGORIES } from "@wealthfolio/addon-sdk/permissions";
import ts from "typescript";

// The category Wealthfolio 3.13.0 checks for each namespace of `ctx.api`, from the
// guardNamespace calls in type-bridge.ts's createSDKHostAPIBridge and from createAddonScopedSecrets
// in addons-runtime-context.ts; null needs no grant. Only the namespaces src/ uses are listed, so
// another one fails as unknown: read its guard in the host before adding it here. `events` and
// `network` aren't plain namespaces there (a network request with `auth` also needs secrets.use).
const CATEGORIES = {
  accounts: "accounts",
  activities: "activities",
  assets: "assets",
  market: "market-data",
  portfolio: "portfolio",
  quotes: "quotes",
  secrets: "secrets",
  settings: "settings",
  snapshots: "snapshots",
  spending: "spending",
  logger: null,
  navigation: null,
  query: null,
  storage: null,
  toast: null,
};
// Spending's functions that Wealthfolio checks under another category.
const SPENDING = {
  searchCashActivities: "activities",
  assignCategory: "activities",
  unassignCategory: "activities",
  setEvent: "activities",
  upsertBudgetTarget: "budgets",
};
const CATALOGUE = new Map(PERMISSION_CATEGORIES.map((c) => [c.id, new Set(c.functions)]));

// The category a function needs; null for none, undefined when unknown.
function categoryOf({ namespace, fn }) {
  const category = namespace === "spending" && Object.hasOwn(SPENDING, fn) ? SPENDING[fn]
    : Object.hasOwn(CATEGORIES, namespace) ? CATEGORIES[namespace] : undefined;
  return category === null || CATALOGUE.get(category)?.has(fn) ? category : undefined;
}

// Made-up code that checks the scan itself, one case per line of an in-memory file beside the
// tests, with what the scan should report there: the uses it finds, or "untraced".
const CASES = {
  property: ["api.activities.saveMany({});", ["activities.saveMany"]],
  element: ['api.activities["saveMany"]({});', ["activities.saveMany"]],
  alias: ["const f = api.activities.saveMany; f({});", ["activities.saveMany"]],
  destructured: ["const { activities: { saveMany } } = api; saveMany({});", ["activities.saveMany"]],
  parameter: ["function f({ activities }: Api) { activities.saveMany({}); } f(api);", ["activities.saveMany"]],
  pick: ['function f(a: Pick<Api["activities"], "saveMany">) { a.saveMany({}); } f(api.activities);', ["activities.saveMany"]],
  omit: ['function f(a: Omit<Api["activities"], "getAll">) { a.saveMany({}); } f(api.activities);', ["activities.saveMany"]],
  intersection: ['function f(a: Api["activities"] & { extra?: string }) { a.saveMany({}); } f(api.activities);', ["activities.saveMany"]],
  optional: ["const a: Api | undefined = api; a?.activities.saveMany({});", ["activities.saveMany"]],
  spread: ["const a = { ...api.activities }; a.saveMany({});", ["activities.saveMany"]],
  callback: ['function f(read: () => Api["activities"]) { read().saveMany({}); } f(() => api.activities);', ["activities.saveMany"]],
  props: ['function C({ a }: { a: Api["activities"] }) { a.saveMany({}); return null; } <C a={api.activities} />;', ["activities.saveMany"]],
  deps: ["useMemo(() => api.activities.saveMany({}), [api]);", ["activities.saveMany"]],
  union: ["const a = Math.random() ? api.accounts : api.goals; a.getAll();", ["accounts.getAll", "goals.getAll"]],
  unrelated: ["const a = { saveMany() {} }; a.saveMany();", []],
  local: ["function f(a: Local) { a.saveMany({}); } f(api.activities);", "untraced"],
  optionalLocal: ["function f(a?: Local) { a?.saveMany({}); } f(api.activities);", "untraced"],
  annotated: ["const a: Local = api.activities; a.saveMany({});", "untraced"],
  asserted: ["(api.activities as Local).saveMany({});", "untraced"],
  nested: ["function f(c: { api: { activities: Local } }) { c.api.activities.saveMany({}); } f({ api });", "untraced"],
  record: ['const a: Record<"saveMany", (r: never) => unknown> = api.activities; a.saveMany({} as never);', "untraced"],
  computed: ['const key = "saveMany"; api.activities[key]({});', "untraced"],
  computedPattern: ['const { ["saveMany" as "saveMany"]: f } = api.activities; f({});', "untraced"],
  satisfies: ['const a = { activities: api.activities } satisfies { activities: Local }; a.activities.saveMany({});', ["activities.saveMany"]],
  satisfiesLocal: ['const a: Local = api.activities satisfies Local; a.saveMany({});', "untraced"],
};
const HEADER = `import type { AddonContext } from "@wealthfolio/addon-sdk";
import { useMemo } from "react";
type Api = AddonContext["api"];
type Local = { saveMany(request: unknown): unknown };
`;

const ROOT = resolve(import.meta.dirname, "..");
const config = ts.getParsedCommandLineOfConfigFile(resolve(ROOT, "tsconfig.json"), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => assert.fail(ts.flattenDiagnosticMessageText(d.messageText, "\n")),
});
const rel = (file) => relative(ROOT, file).replaceAll("\\", "/");
const SRC = config.fileNames.filter((file) => rel(file).startsWith("src/"));
const FIXTURE = ts.normalizePath(resolve(ROOT, "tests/permissions-fixture.tsx"));
const host = ts.createCompilerHost(config.options);
const readSource = host.getSourceFile;
host.getSourceFile = (file, ...rest) => file === FIXTURE
  ? ts.createSourceFile(file, HEADER + Object.values(CASES).map(([code]) => `(api: Api) => { ${code} };`).join("\n"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  : readSource(file, ...rest);
const program = ts.createProgram([...SRC, FIXTURE], config.options, host);
const checker = program.getTypeChecker();
const hostApi = program.getSourceFiles().find((f) => f.fileName.endsWith("/@wealthfolio/addon-sdk/dist/src/host-api.d.ts"));
assert.ok(hostApi, "the SDK's host-api.d.ts isn't in the program");
// Each namespace's interface by HostAPI's members: `activities: ActivitiesAPI;`.
const hostApiInterface = hostApi.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === "HostAPI");
const NAMESPACES = new Map(hostApiInterface.members.map((m) => [m.type.typeName.text, m.name.text]));

// The functions of the SDK's `ctx.api` a symbol is, as { namespace: "activities", fn: "create" },
// or "import.onDrop" for `events.import.onDrop`. A union's property can be several.
function apiFunctions(symbol) {
  const functions = [];
  for (const declaration of symbol?.declarations ?? []) {
    if (declaration.getSourceFile() !== hostApi) continue;
    if (!checker.getTypeOfSymbol(checker.getSymbolAtLocation(declaration.name)).getCallSignatures().length) continue;
    const path = [];
    for (let node = declaration; node; node = node.parent) {
      if (ts.isPropertySignature(node) || ts.isMethodSignature(node)) path.unshift(node.name.text);
      if (ts.isInterfaceDeclaration(node)) {
        const namespace = NAMESPACES.get(node.name.text);
        if (namespace) functions.push({ namespace, fn: path.join(".") });
        break;
      }
    }
  }
  return functions;
}
const needsGrant = (symbol) => apiFunctions(symbol).some((fn) => categoryOf(fn) !== null);

// Whether a value of this type holds an SDK function that needs a grant, as `ctx`, `ctx.api`, or
// a `{ activities: Pick<…> }` does. Only properties declared in src/, the fixture or the SDK are
// followed.
const holding = new Map();
const ours = (symbol) => symbol.declarations?.some((d) => {
  const file = d.getSourceFile().fileName;
  return SRC.includes(file) || file === FIXTURE || file.includes("/@wealthfolio/addon-sdk/");
});
function holds(type) {
  if (!holding.has(type)) {
    holding.set(type, false);
    holding.set(type, checker.getNonNullableType(type).getProperties().some((p) =>
      needsGrant(p) || !apiFunctions(p).length && ours(p) && holds(checker.getTypeOfSymbol(p))));
  }
  return holding.get(type);
}

// An SDK function `source` holds that `target`, a type declared outside the SDK, would hide:
// passing `ctx.api` where `{ activities: { create(…): … } }` is expected, for example. The
// checker resolves a call through such a type to that type, not to the SDK.
function hidden(source, target, depth = 0) {
  if (depth > 3 || source === target) return;
  [source, target] = [checker.getNonNullableType(source), checker.getNonNullableType(target)];
  for (const property of checker.getPropertiesOfType(target)) {
    const from = source.getProperty(property.name);
    if (!from) continue;
    const fns = apiFunctions(from);
    if (needsGrant(from) && !apiFunctions(property).length) return fns.find((fn) => categoryOf(fn) !== null);
    if (!fns.length) {
      const inner = hidden(checker.getTypeOfSymbol(from), checker.getTypeOfSymbol(property), depth + 1);
      if (inner) return inner;
    }
  }
}
// `const { getAll } = api.activities`: the initializer's contextual type is the pattern's own,
// and the scan follows the names it binds.
const destructured = (node) =>
  ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && !node.parent.type && ts.isObjectBindingPattern(node.parent.name);

// `satisfies` checks a shape without replacing the SDK type, including in nested objects.
function erasingContext(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isSatisfiesExpression(parent)) return;
    if (ts.isAssertionExpression(parent) || ts.isCallExpression(parent) || ts.isJsxAttribute(parent) || ts.isJsxSpreadAttribute(parent)
      || ts.isVariableDeclaration(parent) && parent.type || ts.isFunctionLike(parent) && parent.type
      || ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) break;
  }
  return checker.getContextualType(node);
}

const where = (node) => {
  const file = node.getSourceFile();
  return `${rel(file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
};

// The uses of SDK functions in these files, and where an API object goes somewhere the scan
// can't follow: into a type declared outside the SDK, or read with a computed key. Erasing a
// type on purpose, with `any` or `unknown`, or through a generic's constraint, isn't followed.
function scan(files) {
  const uses = [];
  const untraced = new Set();
  // `api.activities[name]` or `const { [name]: fn } = api.activities`: no function to name.
  const unnamed = (node, object) => {
    if (holds(checker.getTypeAtLocation(object))) untraced.add(`${node.getText()} (${where(node)})`);
  };
  for (const file of files) {
    ts.forEachChild(file, function visit(node) {
      let symbol;
      if (ts.isPropertyAccessExpression(node)) symbol = checker.getSymbolAtLocation(node.name);
      else if (ts.isElementAccessExpression(node)) {
        if (ts.isStringLiteralLike(node.argumentExpression)) symbol = checker.getSymbolAtLocation(node.argumentExpression);
        else unnamed(node, node.expression);
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const name = node.propertyName ?? node.name;
        if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) symbol = checker.getTypeAtLocation(node.parent).getProperty(name.text);
        else unnamed(node, node.parent);
      }
      for (const fn of apiFunctions(symbol)) uses.push({ ...fn, at: where(node) });
      const type = ts.isExpression(node) && checker.getTypeAtLocation(node);
      if (type && holds(type) && !destructured(node)) {
        const target = erasingContext(node);
        const fn = target && hidden(type, target);
        if (fn) untraced.add(`${fn.namespace}.${fn.fn} (${where(node)})`);
      }
      ts.forEachChild(node, visit);
    });
  }
  return { uses, untraced: [...untraced] };
}

// What the uses need against what the manifest's permissions declare, as "category: function".
function compare(uses, permissions) {
  const declared = new Set(permissions.flatMap((p) => p.functions.map((fn) => `${p.category}: ${fn}`)));
  const needed = new Map();
  const unknown = [];
  for (const use of uses) {
    const category = categoryOf(use);
    if (category === undefined) unknown.push(`${use.namespace}.${use.fn} (${use.at})`);
    else if (category !== null && !needed.has(`${category}: ${use.fn}`)) needed.set(`${category}: ${use.fn}`, use.at);
  }
  return {
    unknown,
    undeclared: [...needed].filter(([key]) => !declared.has(key)).map(([key, at]) => `${key} (${at})`),
    unused: [...declared].filter((key) => !needed.has(key)),
  };
}

const { uses, untraced } = scan(program.getSourceFiles().filter((f) => SRC.includes(f.fileName)));
const manifest = JSON.parse(await readFile(resolve(ROOT, "manifest.json"), "utf8"));
const result = compare(uses, manifest.permissions);

test("each function gets the category Wealthfolio checks", () => {
  assert.equal(categoryOf({ namespace: "market", fn: "searchTicker" }), "market-data");
  for (const [fn, category] of Object.entries(SPENDING)) assert.equal(categoryOf({ namespace: "spending", fn }), category);
  assert.equal(categoryOf({ namespace: "spending", fn: "getContext" }), "spending");
  for (const namespace of ["logger", "query", "storage", "toast", "navigation"]) assert.equal(categoryOf({ namespace, fn: "anything" }), null);
  assert.equal(categoryOf({ namespace: "goals", fn: "getAll" }), undefined);
  assert.equal(categoryOf({ namespace: "activities", fn: "notInTheSDK" }), undefined);
});

test("the scan follows the SDK's types and reports API objects it can't follow", () => {
  const file = program.getSourceFile(FIXTURE);
  assert.deepEqual(program.getSemanticDiagnostics(file).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
  const fixture = scan([file]);
  const first = HEADER.split("\n").length;
  Object.entries(CASES).forEach(([name, [, expected]], i) => {
    const at = `${rel(FIXTURE)}:${first + i}`;
    assert.equal(fixture.untraced.some((u) => u.endsWith(`(${at})`)), expected === "untraced", name);
    if (expected !== "untraced") {
      assert.deepEqual(fixture.uses.filter((u) => u.at === at).map((u) => `${u.namespace}.${u.fn}`).sort(), expected, name);
    }
  });
  const at = (name) => `${rel(FIXTURE)}:${first + Object.keys(CASES).indexOf(name)}`;
  assert.deepEqual(compare(fixture.uses, [{ category: "activities", functions: ["saveMany", "search"] }]), {
    unknown: [`goals.getAll (${at("union")})`],
    undeclared: [`accounts: getAll (${at("union")})`],
    unused: ["activities: search"],
  });
});

test("the scan finds calls through API objects passed in", () => {
  const found = (file, call) => uses.some((u) => u.at.startsWith(`${file}:`) && `${u.namespace}.${u.fn}` === call);
  for (const call of ["activities.create", "activities.update", "activities.linkTransfer", "settings.get"]) {
    assert.ok(found("src/cas/plan.ts", call), call);
  }
  for (const call of ["spending.getContext", "spending.searchCashActivities", "spending.unassignCategory", "activities.getAll", "activities.getTransferPair"]) {
    assert.ok(found("src/cas/bank-entries.ts", call), call);
  }
});

test("every Wealthfolio function src/ uses has a known permission", () => {
  assert.deepEqual(result.unknown, [], "the category these need isn't known: read the host's guard and add it to CATEGORIES");
});

test("no API object goes into a type the scan can't follow", () => {
  assert.deepEqual(untraced, [], "type these with the SDK's types, such as Pick<AddonContext[\"api\"][\"activities\"], …>");
});

test("manifest.json declares every permission src/ needs", () => {
  assert.deepEqual(result.undeclared, [], "Wealthfolio refuses these calls: declare them in manifest.json");
});

test("manifest.json declares no permission src/ doesn't need", () => {
  assert.deepEqual(result.unused, [], "src/ doesn't use these: drop them from manifest.json");
});
