// casparser's warnings on the Review screen, in plain words: casparser 1.4.1's five kinds, read from
// its text as it writes them under the add-on's Pyodide, and any other kept to copy and report.
// Made-up funds and numbers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fundKey } from "../src/lib/choices.ts";
import { readWarning, warningLines } from "../src/lib/parse-warnings.ts";

const MISREAD = "; a transaction row may be missing or mis-parsed";
const balance = (label, date, type, computed, printed, delta) =>
  `${label}: unit-balance discontinuity at ${date} (${type}) — computed ${computed} but statement printed ${printed} (Δ=${delta})${MISREAD}`;
const closing = (label, computed, printed, delta) => `${label}: closing unit balance mismatch — computed ${computed} but statement printed ${printed} (Δ=${delta})${MISREAD}`;
const onPage = (page, text) =>
  `unparseable scheme header region before 'Opening Unit Balance' on page ${page}; the scheme and its transactions were skipped: ${text}`;
const discarded = (where, text) =>
  `scheme header region discarded at ${where} without an 'Opening Unit Balance' anchor; its scheme and transactions were skipped: ${text}`;
const inferred = (isin) => `MF holdings ${isin}: no closing nav/value pair; inferred from max tail`;

const FLEXI = "'Fictiva Flexi Cap Fund - Direct Plan - Growth' [FFCDG]";
const flexiGap = balance(FLEXI, "2023-10-10", "TransactionType.PURCHASE_SIP", "1831.591", "1925.629", "-94.038");

const scheme = (name, code, isin, close, calculated = close) => ({ scheme: name, rta_code: code, rta: "CAMS", isin, close, close_calculated: calculated });
const flexi = scheme("Fictiva Flexi Cap Fund - Direct Plan - Growth", "FFCDG", "INFZ90K01FC8", "2892.104", "2798.066");
const liquid = scheme("Fictiva Liquid Fund - Direct Plan - Growth", "FLQDG", "INFZ90K01LQ6", "8.053");
const statement = { folios: [{ folio: "91234567 / 12", schemes: [flexi, liquid] }] };
/** The Review screen's names, as a detailed one shortens them, for the funds it lists. */
const listed = new Map([[fundKey(flexi), "Fictiva Flexi Cap Fund"], [fundKey(liquid), "Fictiva Liquid Fund"]]);
const nameOf = (key) => listed.get(key);
const lines = (warnings, context = {}) => warningLines(warnings, { statement, nameOf, ...context }).map((l) => (l.message === undefined ? l.text : l));

test("casparser 1.4.1's five warnings are read from its text", () => {
  assert.deepEqual(readWarning(flexiGap), {
    kind: "balance",
    scheme: { name: "Fictiva Flexi Cap Fund - Direct Plan - Growth", code: "FFCDG" },
    date: "2023-10-10",
    type: "TransactionType.PURCHASE_SIP",
    computed: "1831.591",
    printed: "1925.629",
  });
  assert.deepEqual(readWarning(closing(FLEXI, "2798.066", "2892.104", "-94.038")), {
    kind: "closing",
    scheme: { name: "Fictiva Flexi Cap Fund - Direct Plan - Growth", code: "FFCDG" },
    computed: "2798.066",
    printed: "2892.104",
  });
  assert.deepEqual(readWarning(onPage(3, "'FFXDG-Fictiva X Fund / Registrar : CAMS'")), { kind: "skipped", page: "3", text: "FFXDG-Fictiva X Fund / Registrar : CAMS" });
  assert.deepEqual(readWarning(discarded("folio boundary", "'FFXDG-Fictiva X Fund'")), { kind: "skipped", where: "folio boundary", text: "FFXDG-Fictiva X Fund" });
  assert.deepEqual(readWarning(inferred("INFZ90K01BA1")), { kind: "value", isin: "INFZ90K01BA1" });
  // casparser quotes names and printed text as Python's repr does: a control character is an escape,
  // and a name with a single quote is in double quotes, unless it has a double quote too.
  const quoted = [
    [String.raw`'Fictiva\x02 Flexi Cap Fund\x7f'`, "Fictiva\u0002 Flexi Cap Fund\u007f"],
    [`"Fictiva Investor's Fund"`, "Fictiva Investor's Fund"],
    [String.raw`'Fictiva\'s "Fund"'`, `Fictiva's "Fund"`],
    [String.raw`'Back\\slash\tTab\nLine\rReturn\u2028\U000e0001'`, "Back\\slash\tTab\nLine\rReturn\u2028\u{e0001}"],
  ];
  for (const [repr, name] of quoted) {
    assert.deepEqual(readWarning(closing(`${repr} [FX]`, "1", "2", "-1")).scheme, { name, code: "FX" }, repr);
    assert.equal(readWarning(onPage(1, repr)).text, name, repr);
  }
  // An older Python formats the row type as its value.
  assert.equal(readWarning(balance(FLEXI, "2023-10-10", "PURCHASE_SIP", "1", "2", "-1")).type, "PURCHASE_SIP");
  // Text that's any different, as a later casparser may write, isn't read as one of these.
  for (const text of [
    flexiGap.replace("mis-parsed", "misparsed"),
    inferred("X").replace("max tail", "the tail"),
    "Fictiva [FFCDG]: closing unit balance mismatch",
    ...[flexiGap, closing(FLEXI, "1", "2", "-1"), onPage(1, "'Fictiva Fund'"), discarded("folio boundary", "'Fictiva Fund'"), inferred("INFZ90K01BA1")]
      .map((text) => `${text}\n`),
  ]) {
    assert.deepEqual(readWarning(text), { kind: "other", text });
  }
});

test("malformed repr names and snippets keep the warning's message instead of changing its details", () => {
  for (const repr of [
    String.raw`'Fictiva\q Fund'`,
    String.raw`'Fictiva\xZZ Fund'`,
    String.raw`'Fictiva\u123 Fund'`,
    String.raw`'Fictiva\U00110000 Fund'`,
    "'Fictiva\nFund'",
  ]) {
    for (const text of [closing(`${repr} [FX]`, "1", "2", "-1"), onPage(1, repr)]) {
      assert.deepEqual(readWarning(text), { kind: "other", text });
    }
  }
  const literalSlash = String.raw`'Fictiva\\q Fund'`;
  assert.equal(readWarning(onPage(1, literalSlash)).text, String.raw`Fictiva\q Fund`);
});

test("a fund's rows that don't add up are worded as the Review screen words funds, dates and units", () => {
  assert.deepEqual(lines([flexiGap]), [
    "Fictiva Flexi Cap Fund: after the SIP purchase on 10 Oct 2023, its rows add up to 1,831.591 units, but the statement prints 1,925.629. A row may be missing or misread.",
  ]);
  const liquidLabel = "'Fictiva Liquid Fund - Direct Plan - Growth' [FLQDG]";
  assert.deepEqual(lines([closing(liquidLabel, "8.1", "8.053", "0.047")]), [
    "Fictiva Liquid Fund: its rows add up to 8.100 units, but the statement's closing balance is 8.053. A row may be missing or misread.",
  ]);
  // Each row type as a word; one without a word is "the row".
  const words = [
    ["TransactionType.REDEMPTION", "the redemption"],
    ["SWITCH_IN_MERGER", "the switch in"],
    ["TransactionType.DIVIDEND_REINVEST", "the reinvested dividend"],
    ["TransactionType.STAMP_DUTY_TAX", "the stamp duty"],
    ["TransactionType.SEGREGATION", "the credit of segregated units"],
    ["TransactionType.GIFT_OUT", "the gift given"],
    ["TransactionType.REVERSAL", "the reversal"],
    ["TransactionType.MISC", "the row"],
    ["TransactionType.UNKNOWN", "the row"],
    ["TransactionType.SOMETHING_NEW", "the row"],
  ];
  for (const [type, words_] of words) {
    assert.deepEqual(lines([balance(liquidLabel, "2024-02-29", type, "-12345.5", "102310", "-114655.5")]), [
      `Fictiva Liquid Fund: after ${words_} on 29 Feb 2024, its rows add up to -12,345.500 units, but the statement prints 1,02,310.000. A row may be missing or misread.`,
    ], type);
  }
});

test("a fund a warning names is called what the Review screen calls it, and nothing is made up when it isn't listed", () => {
  // A confirmed fund goes by its listing's name, as the screen's Questions do.
  assert.match(warningLines([flexiGap], { statement, nameOf: () => "Fictiva Flexi Cap Dir Gr" })[0].text, /^Fictiva Flexi Cap Dir Gr: after the SIP purchase /);
  // Its name with control characters, as a CDSL statement prints some, matches the statement's.
  const escaped = flexiGap.replace("'Fictiva Flexi Cap", String.raw`'Fictiva\x02 Flexi Cap`);
  const withControl = { folios: [{ folio: "1", schemes: [{ ...flexi, scheme: "Fictiva\u0002 Flexi Cap Fund - Direct Plan - Growth" }] }] };
  assert.match(warningLines([escaped], { statement: withControl, nameOf })[0].text, /^Fictiva Flexi Cap Fund: after/);
  // A scheme the screen doesn't list, such as a closed one, by its printed name, shortened as the
  // screen shortens fund names; without a readable name, by its scheme code; without either, "A fund".
  const unlisted = (label) => warningLines([closing(label, "1", "2", "-1")], { statement, nameOf })[0].text;
  assert.match(unlisted("'Fictiva Midcap Fund - Direct Plan - Growth' [FMCDG]"), /^Fictiva Midcap Fund: its rows add up to 1\.000 units, /);
  assert.match(unlisted(String.raw`'\x02' [FMCDG]`), /^The fund with scheme code FMCDG: its rows /);
  assert.match(unlisted("'' []"), /^A fund: its rows /);
  assert.match(warningLines([flexiGap], { nameOf })[0].text, /^Fictiva Flexi Cap Fund: after/);
  // A depository statement's fund goes by its ISIN's holding; one the screen doesn't list by its ISIN.
  const holdings = (isin) => warningLines([inferred(isin)], { nameOf: (key) => (key === "isin:INFZ90K01BA1" ? "Fictiva Balanced Advantage Fund" : undefined) })[0].text;
  assert.equal(
    holdings("INFZ90K01BA1"),
    "Fictiva Balanced Advantage Fund: its NAV and value couldn't be read from its line, so the largest amount on that line was taken as its value. Check its NAV, value and cost against the PDF.",
  );
  assert.match(holdings("INFZ90K01ZZ9"), /^The fund with ISIN INFZ90K01ZZ9: its NAV and value /);
  assert.match(holdings(""), /^A fund: its NAV and value /);
});

test("a fund that wasn't read says its transactions aren't imported, and where to find it in the PDF", () => {
  const after = "Its transactions aren't in this import: find it in the PDF and add them in Wealthfolio yourself.";
  assert.deepEqual(lines([onPage(3, "'FFXDG-Fictiva X Fund - Direct Plan - Growth / Registrar : CAMS'")]), [
    `A fund on page 3 couldn't be read: “FFXDG-Fictiva X Fund - Direct Plan - Growth / Registrar : CAMS”. ${after}`,
  ]);
  assert.deepEqual(lines([onPage(12, "''")]), [`A fund on page 12 couldn't be read. ${after}`]);
  assert.deepEqual(
    lines(["AMC boundary", "folio boundary", "end of document", "somewhere new"].map((where) => discarded(where, String.raw`'FFYDG-Fictiva\x02 Y Fund'`))),
    [
      `A fund just before the next fund house couldn't be read: “FFYDG-Fictiva Y Fund”. ${after}`,
      `A fund just before the next folio couldn't be read: “FFYDG-Fictiva Y Fund”. ${after}`,
      `A fund at the end of the statement couldn't be read: “FFYDG-Fictiva Y Fund”. ${after}`,
      `A fund couldn't be read: “FFYDG-Fictiva Y Fund”. ${after}`,
    ],
  );
});

test("a warning the add-on doesn't recognise keeps casparser's text to copy and report", () => {
  assert.deepEqual(lines(["Fictiva\u0002 Flexi Cap Fund: something new happened  here"]), [
    { text: "casparser found something it couldn't read cleanly. To report it, copy its message:", message: "Fictiva Flexi Cap Fund: something new happened here" },
  ]);
});

test("a closing balance warning isn't repeated beside the question about its fund, and each line shows once", () => {
  const flexiClosing = closing(FLEXI, "2798.066", "2892.104", "-94.038");
  const liquidClosing = closing("'Fictiva Liquid Fund - Direct Plan - Growth' [FLQDG]", "8", "8.053", "-0.053");
  const midcapClosing = closing("'Fictiva Midcap Fund - Direct Plan - Growth' [FMCDG]", "1", "2", "-1");
  // A detailed Review screen asks about Flexi Cap, whose rows add up to less than its closing balance.
  // Liquid's rows add up by the add-on's sum, so it isn't asked about; Midcap isn't on the statement.
  assert.deepEqual(lines([flexiGap, flexiClosing, liquidClosing, midcapClosing], { asksUnbalanced: true }).map((l) => l.split(":")[0]), [
    "Fictiva Flexi Cap Fund",
    "Fictiva Liquid Fund",
    "Fictiva Midcap Fund",
  ]);
  // A screen that doesn't ask keeps it.
  assert.equal(lines([flexiClosing]).length, 1);
  // Two folios holding the scheme: left out only when every one is asked about.
  const twice = (other) => ({ folios: [{ folio: "1", schemes: [flexi] }, { folio: "2", schemes: [other] }] });
  assert.equal(warningLines([flexiClosing], { statement: twice(flexi), nameOf, asksUnbalanced: true }).length, 0);
  assert.equal(warningLines([flexiClosing], { statement: twice({ ...flexi, close_calculated: flexi.close }), nameOf, asksUnbalanced: true }).length, 1);
  // A warning repeated word for word, or naming a fund in two ways that read the same, shows once.
  const escaped = flexiGap.replace("'Fictiva Flexi Cap", String.raw`'Fictiva\x02 Flexi Cap`);
  assert.equal(lines([flexiGap, flexiGap, escaped]).length, 1);
  assert.deepEqual(lines([]), []);
});
