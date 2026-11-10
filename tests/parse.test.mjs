// casparser under Pyodide in Node, with the packaged wheels (run `pnpm runtime` first), the
// add-on's stub and entry point, on the made-up statements in tests/fixtures/ (make_*.py).
// tests/browser/sandbox.mjs checks the same in browsers, inside Wealthfolio's sandbox.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, test } from "node:test";
import { abs, cmp, dec, mul, sub } from "../src/cas/decimal.ts";
import { loadRuntime } from "./runtime.mjs";

const PASSWORD = "ABCDE1234F";
let parse;

before(async () => {
  parse = (await loadRuntime()).pyimport("cas_parse").parse;
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

test("gives each trade amount ÷ units as its NAV when the statement has no Price column", async () => {
  const { pdf, expected } = await fixture("made-up-cas-no-price");
  const data = JSON.parse(parse(pdf, PASSWORD));
  assert.deepEqual(data, expected);
  assert.deepEqual(data.parse_warnings, []);
  // The made-up statement without its Price column: only the trades' NAVs differ, and nothing marks them (#90).
  const printed = (await fixture("made-up-cas")).expected;
  const rows = (statement) => statement.folios.flatMap((f) => f.schemes.flatMap((s) => s.transactions));
  const restored = structuredClone(data);
  const printedRows = rows(printed);
  let trades = 0;
  let differ = 0;
  rows(restored).forEach((row, i) => {
    const { amount, units, nav } = row;
    if (printedRows[i].nav === null) return;
    // The 4-place NAV nearest amount ÷ units.
    assert.equal(dec(nav).scale, 4, nav);
    assert.ok(cmp(abs(sub(mul(dec(nav), dec(units)), dec(amount))), mul(abs(dec(units)), dec("0.00005"))) <= 0, nav);
    trades++;
    if (nav !== printedRows[i].nav) differ++;
    row.nav = printedRows[i].nav;
  });
  assert.deepEqual(restored, printed);
  assert.deepEqual([trades, differ], [36, 26]);
});

test("reads a segregated portfolio's own scheme and its units credited without an amount or NAV", async () => {
  const { pdf, expected } = await fixture("made-up-cas-segregated");
  const data = JSON.parse(parse(pdf, PASSWORD));
  assert.deepEqual(data, expected);
  assert.deepEqual(data.parse_warnings, []);
  const [main, segregated] = data.folios[0].schemes;
  assert.notEqual(segregated.isin, main.isin);
  // The note under the segregated portfolio's closing line doesn't join its last row.
  assert.deepEqual(
    segregated.transactions.map((row) => [row.type, row.description, row.amount, row.units, row.nav]),
    [
      ["SEGREGATION", "Creation of units - Segregated Portfolio", null, "3067.468", null],
      ["SEGREGATION", "Creation of units - Segregated Portfolio", null, "0.013", null],
      ["REDEMPTION", "Payment - Units Extinguished", "-920.24", "-1533.741", "0.6000"],
    ],
  );
  // One segregated unit for each unit the main portfolio held that day.
  const held = main.transactions.filter((row) => row.date < "2024-02-16" && row.balance !== null).at(-1).balance;
  assert.equal(held, segregated.transactions[1].balance);
});

for (const name of ["made-up-summary-cams", "made-up-summary-kfintech", "made-up-nsdl", "made-up-cdsl"]) {
  test(`parses every holding of ${name}`, async () => {
    const { pdf, expected } = await fixture(name);
    const data = JSON.parse(parse(pdf, PASSWORD));
    assert.deepEqual(data, expected);
    assert.deepEqual(data.parse_warnings, []);
  });
}

test("rejects a wrong password", async () => {
  const { pdf } = await fixture("made-up-cas");
  assert.throws(() => parse(pdf, "WRONGPASS1"), { type: "IncorrectPasswordError" });
  assert.throws(() => parse(pdf, ""), { type: "IncorrectPasswordError" });
});

test("reads a statement without a password, whatever the password", async () => {
  const { expected } = await fixture("made-up-cas");
  const pdf = new Uint8Array(await readFile("tests/fixtures/made-up-cas-no-password.pdf"));
  for (const password of ["", "anything"]) assert.deepEqual(JSON.parse(parse(pdf, password)), expected, password);
});
