// The accounts the add-on proposes when none fits: their names, numbers and what's sent to create one.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountName,
  holdingsBase,
  isProposed,
  NAME_MAX,
  nameProblem,
  newAccount,
  proposalKey,
  proposedId,
  proposedNames,
  sourceBase,
} from "../src/lib/new-accounts.ts";

test("a proposed account's ID is its choice's key behind a prefix no account has", () => {
  const id = proposedId("pan:abc");
  assert.ok(isProposed(id));
  assert.equal(proposalKey(id), "pan:abc");
  for (const other of ["8f14e45f-ceea-467f-a0e6-2f7a1a5d1e4c", "", null, undefined, "left-out", "outside"]) assert.equal(isProposed(other), false);
});

test("Rename takes 2 to 50 characters once trimmed, as Wealthfolio's account form does", () => {
  assert.equal(nameProblem(""), "Enter an account name.");
  assert.equal(nameProblem("   "), "Enter an account name.");
  assert.equal(nameProblem(" A "), "Use at least 2 characters.");
  assert.equal(nameProblem("AB"), undefined);
  assert.equal(nameProblem(` ${"x".repeat(50)} `), undefined);
  assert.equal(nameProblem("x".repeat(51)), "Use at most 50 characters.");
});

test("a generated name fits in 50 characters, shortening the base before the investor's name", () => {
  assert.equal(accountName("Mutual funds"), "Mutual funds");
  assert.equal(accountName("Mutual funds", "B. Investor"), "Mutual funds (B. Investor)");
  assert.equal(accountName("Mutual funds", "B. Investor", 2), "Mutual funds (B. Investor) 2");
  assert.equal(accountName("  Mutual   funds ", "  B.  Investor "), "Mutual funds (B. Investor)");
  const base = "Testbridge Securities Private Limited Holdings demat";
  const long = accountName(base);
  assert.equal(long, "Testbridge Securities Private Limited Holdings de…");
  assert.equal(long.length, NAME_MAX);
  // The base gives way to the investor's name and the number, down to 16 characters, then the name is cut too.
  const both = accountName(base, "Bhavya Rajeshwari Testwala", 12);
  assert.equal(both, "Testbridge Securi… (Bhavya Rajeshwari Testwala) 12");
  const longest = accountName(base, "Bhavya Rajeshwari Testwala Venkatanarasimharajuvaripeta", 3);
  assert.equal(longest, "Testbridge Secu… (Bhavya Rajeshwari Testwala V…) 3");
  // A character outside the BMP isn't cut in half.
  const emoji = accountName(`${"x".repeat(48)}😀😀`);
  assert.equal(emoji, `${"x".repeat(48)}…`);
  // A base too short for the rule says what it is.
  assert.equal(accountName("X"), "X account");
  assert.equal(accountName(" "), "account");
  for (const name of [long, both, longest, emoji, accountName("X")]) assert.equal(nameProblem(name), undefined, name);
});

test("a name an account already has, in any case, or an earlier proposal has, gets a number", () => {
  const names = proposedNames(
    [
      { key: "a", base: "Mutual funds" },
      { key: "b", base: "Mutual funds", who: "B. Investor" },
      { key: "c", base: "Mutual funds", who: "B. Investor" },
      { key: "d", base: "CDSL Demat" },
    ],
    ["mutual  FUNDS", "Mutual funds 2", "CDSL demat ", "Savings"],
  );
  assert.deepEqual([...names], [
    ["a", "Mutual funds 3"],
    ["b", "Mutual funds (B. Investor)"],
    ["c", "Mutual funds (B. Investor) 2"],
    ["d", "CDSL Demat 2"],
  ]);
});

test("a long investor's and source's name with a collision still fits, without opening Rename", () => {
  const who = "Bhavya Rajeshwari Testwala Venkatanarasimharajuvaripeta";
  const first = accountName("Fictiva Mutual Fund folio 91234567 / 12", who);
  const names = proposedNames([{ key: "x", base: "Fictiva Mutual Fund folio 91234567 / 12", who }], [first]);
  const name = names.get("x");
  assert.notEqual(name, first);
  assert.ok(name.endsWith(" 2"), name);
  assert.ok(name.length <= NAME_MAX, name);
  assert.equal(nameProblem(name), undefined);
});

test("a renamed account keeps its name, which the others then don't take", () => {
  const names = proposedNames(
    [{ key: "a", base: "Mutual funds" }, { key: "b", base: "Fictiva" }],
    [],
    { b: "Mutual funds" },
  );
  assert.deepEqual([...names], [["a", "Mutual funds 2"], ["b", "Mutual funds"]]);
});

test("the investor's account is named after the depository, or funds for a registrar's statement", () => {
  assert.equal(holdingsBase("CDSL"), "CDSL Demat");
  assert.equal(holdingsBase("NSDL"), "NSDL Demat");
  assert.equal(holdingsBase("CAMS"), "Mutual funds");
  assert.equal(holdingsBase("KFINTECH"), "Mutual funds");
});

test("a folio's, demat account's or PRAN's own account is named after it", () => {
  assert.equal(sourceBase({ kind: "folio", label: "Fictiva Mutual Fund, folio 7712045", title: "Fictiva Mutual Fund account (folio 7712045)" }), "Fictiva Mutual Fund folio 7712045");
  assert.equal(sourceBase({ kind: "folio", label: "Folio 7712045", title: "Mutual fund folio 7712045" }), "Mutual fund folio 7712045");
  assert.equal(sourceBase({ kind: "demat", label: "CDSL Demat Account 1, Testbridge Securities", title: "Testbridge Securities demat account" }), "Testbridge Securities demat");
  // Two at one broker: the numbers tell them apart.
  assert.equal(
    sourceBase({ kind: "demat", label: "CDSL Demat Account 2, Testbridge Securities", title: "Testbridge Securities demat account (CDSL Demat Account 2, Testbridge Securities)" }),
    "Testbridge Securities demat",
  );
  // Without a readable broker, the depository.
  assert.equal(sourceBase({ kind: "demat", label: "NSDL Demat Account 1, \u0002", title: "NSDL Demat Account 1, \u0002" }), "NSDL Demat");
  assert.equal(sourceBase({ kind: "nps", label: "NPS, PRAN XXXXXXXX9001", title: "NPS account (PRAN XXXXXXXX9001)" }), "NPS");
});

test("a new account is a securities account in rupees, not the default, active, with no provider", () => {
  assert.deepEqual(newAccount(" CDSL Demat ", "HOLDINGS"), {
    name: "CDSL Demat", accountType: "SECURITIES", currency: "INR", isDefault: false, isActive: true, trackingMode: "HOLDINGS",
  });
  assert.equal(newAccount("Mutual funds", "TRANSACTIONS").trackingMode, "TRANSACTIONS");
});
