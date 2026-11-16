// How the Review screen names accounts: an account another one shares its name with is told apart.
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountLabels, numberEnd } from "../src/lib/account-labels.ts";
import { fold } from "../src/lib/new-accounts.ts";

const account = (id, name, more = {}) => ({ id, name, currency: "INR", trackingMode: "HOLDINGS", ...more });
const labelsOf = (accounts) => [...accountLabels(accounts).values()];
const texts = (accounts) => labelsOf(accounts).map((l) => l.text);
const options = (accounts) => labelsOf(accounts).map((l) => l.option);

test("an account no other one shares its name with is its name alone, with its currency in a select", () => {
  const labels = accountLabels([account("a", " Funds "), account("b", "Savings", { currency: "USD", accountNumber: "1234", group: "Family" })]);
  assert.deepEqual([...labels.entries()], [["a", { text: "Funds", option: "Funds (INR)" }], ["b", { text: "Savings", option: "Savings (USD)" }]]);
});

test("same-named accounts are told apart by the end of their account numbers, as Wealthfolio shows it beside them", () => {
  const funds = [account("a", "Funds", { accountNumber: "1234 5678 4821", group: "Family" }), account("b", "Funds", { accountNumber: "98765432 7310" })];
  assert.deepEqual(texts(funds), ["Funds (ending 4821)", "Funds (ending 7310)"]);
  // A select lists the rest of what Wealthfolio shows beside them, in its order.
  assert.deepEqual(options(funds), ["Funds (ending 4821) · INR · Family group", "Funds (ending 7310) · INR"]);
  // Names compare as Wealthfolio compares them: spaces collapsed, case ignored.
  assert.deepEqual(texts([account("a", "My  funds", { accountNumber: "11" }), account("b", " my funds", { accountNumber: "22" })]), ["My  funds (ending 11)", "my funds (ending 22)"]);
  assert.equal(numberEnd(" 12 345 6 "), "3456");
  assert.equal(numberEnd(" "), undefined);
});

test("without number ends that tell them apart, by currency, group or what they track, the fewest that do", () => {
  // The same number end: the currency.
  assert.deepEqual(texts([account("a", "Funds", { accountNumber: "x4821" }), account("b", "Funds", { accountNumber: "y4821", currency: "USD" })]), ["Funds (INR)", "Funds (USD)"]);
  assert.deepEqual(options([account("a", "Funds"), account("b", "Funds", { currency: "USD" })]), ["Funds (INR)", "Funds (USD)"]);
  const grouped = [account("a", "Funds", { group: "Ananya" }), account("b", "Funds", { group: " Family " })];
  assert.deepEqual(texts(grouped), ["Funds (Ananya group)", "Funds (Family group)"]);
  assert.deepEqual(options(grouped), ["Funds (Ananya group) · INR", "Funds (Family group) · INR"]);
  // A holdings screen can name a same-named account that tracks transactions.
  assert.deepEqual(texts([account("a", "Funds"), account("b", "Funds", { trackingMode: "TRANSACTIONS" }), account("c", "Funds", { trackingMode: "NOT_SET" })]), [
    "Funds (tracks holdings)", "Funds (tracks transactions)", "Funds (tracking not set up)",
  ]);
  // Two details when no one detail tells an account apart; one that has only what another has is numbered.
  assert.deepEqual(texts([account("a", "Funds", { group: "Family" }), account("b", "Funds", { currency: "USD", group: "Family" }), account("c", "Funds", { currency: "USD" })]), [
    "Funds (INR)", "Funds (USD, Family group)", "Funds (account 3)",
  ]);
});

test("with nothing that tells them apart, they're numbered in Wealthfolio's order, and say so", () => {
  const alike = [account("a", "Funds"), account("x", "Other"), account("b", "Funds")];
  assert.deepEqual(labelsOf(alike), [
    { text: "Funds (account 1)", option: "Funds (account 1) · INR", numbered: true },
    { text: "Other", option: "Other (INR)" },
    { text: "Funds (account 2)", option: "Funds (account 2) · INR", numbered: true },
  ]);
  // Each account takes what tells it apart from the others, even when another has nothing.
  assert.deepEqual(texts([account("a", "Funds", { accountNumber: "4821" }), account("b", "Funds"), account("c", "Funds", { group: "Family" })]), [
    "Funds (ending 4821)", "Funds (account 2)", "Funds (Family group)",
  ]);
});

test("numbers follow Settings → Accounts: active accounts, then hidden, then archived, each in Wealthfolio's order", () => {
  // Wealthfolio returns an account that's active but archived before a hidden one; Settings lists it after.
  const funds = [account("a", "Funds", { isActive: true, isArchived: true }), account("b", "Funds", { isActive: false }), account("c", "Funds"), account("d", "Funds")];
  assert.deepEqual(texts(funds), ["Funds (account 4)", "Funds (account 3)", "Funds (account 1)", "Funds (account 2)"]);
});

test("no label reads like another account's name or label", () => {
  // An account named like a label keeps its name; the label takes the next thing that tells it apart.
  assert.deepEqual(texts([account("a", "Funds"), account("b", "Funds"), account("c", "Funds (account 2)")]), [
    "Funds (account 1)", "Funds (account 2 of 2)", "Funds (account 2)",
  ]);
  assert.deepEqual(texts([account("a", "Funds", { currency: "USD" }), account("b", "Funds (USD)"), account("c", "Funds")]), [
    "Funds (USD, tracks holdings)", "Funds (USD)", "Funds (INR)",
  ]);
  // A group named like a currency still reads as a group.
  const labels = texts([account("a", "Funds", { currency: "USD" }), account("b", "Funds", { group: "USD" }), account("c", "Funds")]);
  assert.equal(new Set(labels).size, 3, labels.join(" | "));
});

test("literal names can't exhaust numbered labels, even when those names repeat", () => {
  for (const copies of [1, 2]) {
    const accounts = [account("a", "Funds"), account("b", "Funds")];
    for (const name of ["Funds (account 1)", "Funds (account 1 of 2)", "Funds (account 1 of 2) (account 1 of 2)"]) {
      for (let i = 0; i < copies; i++) accounts.push(account(`${name}-${i}`, name));
    }
    const labels = accountLabels(accounts);
    const names = [...labels.values()].map((l) => fold(l.text));
    assert.equal(new Set(names).size, accounts.length, names.join(" | "));
    for (const a of accounts) {
      const label = labels.get(a.id);
      assert.ok(!accounts.some((other) => other.id !== a.id && fold(other.name) === fold(label.text)), label.text);
      assert.equal(label.numbered, a.name === "Funds" || copies === 2 ? true : undefined);
    }
    assert.deepEqual(accountLabels(accounts), labels);
  }
});

test("a detail label can't take a real name shared by other accounts", () => {
  const accounts = [account("a", "Funds", { currency: "USD" }), account("b", "Funds"), account("c", "Funds (USD)"), account("d", "Funds (USD)")];
  assert.notEqual(fold(accountLabels(accounts).get("a").text), fold("Funds (USD)"));
});
