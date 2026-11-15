// How the Review screen counts its open questions, under Save to and in the questions section.
import assert from "node:assert/strict";
import { test } from "node:test";
import { questionParts, questionsHeading, questionTotal } from "../src/lib/questions-left.ts";

const open = (more) => ({ account: false, checks: 0, cards: 0, fundsOnly: true, ...more });

test("with every open question in the questions section, the count needs no more words", () => {
  const cards = open({ cards: 5 });
  assert.equal(questionTotal(cards), 5);
  assert.equal(questionParts(cards), undefined);
  assert.equal(questionsHeading(cards), "Questions for you");
  assert.equal(questionsHeading(open({ cards: 2, fundsOnly: false })), "Questions for you");
});

test("the account choice is counted by name, and the questions section is named for its own cards", () => {
  // An account to choose and five cards, once counted as "6 questions" beside "5 of 5 left".
  const fundsOnly = open({ account: true, cards: 5 });
  assert.equal(questionTotal(fundsOnly), 6);
  assert.equal(questionParts(fundsOnly), "the account choice and 5 fund questions");
  assert.equal(questionsHeading(fundsOnly), "Fund questions");
  const mixed = open({ account: true, cards: 5, fundsOnly: false });
  assert.equal(questionParts(mixed), "the account choice and 5 other questions");
  assert.equal(questionsHeading(mixed), "Other questions");
  // Only the account choice: the section has no open card to name.
  const alone = open({ account: true });
  assert.equal(questionTotal(alone), 1);
  assert.equal(questionParts(alone), "the account choice");
  assert.equal(questionsHeading(alone), "Questions for you");
});

test("payment checks are counted by name beside the account choice and the cards", () => {
  assert.equal(questionParts(open({ checks: 1 })), "the payment check");
  assert.equal(questionParts(open({ checks: 2 })), "2 payment checks");
  assert.equal(questionParts(open({ checks: 1, cards: 1 })), "the payment check and 1 fund question");
  const all = open({ account: true, checks: 2, cards: 3, fundsOnly: false });
  assert.equal(questionTotal(all), 6);
  assert.equal(questionParts(all), "the account choice, 2 payment checks and 3 other questions");
  assert.equal(questionsHeading(all), "Other questions");
  assert.equal(questionsHeading(open({ checks: 1, cards: 2 })), "Fund questions");
});
