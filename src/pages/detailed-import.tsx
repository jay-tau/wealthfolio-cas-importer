import type { Account, ActivityDetails, ActivityImport, AddonContext, ImportActivitiesResult } from "@wealthfolio/addon-sdk";
import { QueryKeys } from "@wealthfolio/addon-sdk";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Spinner } from "@wealthfolio/ui";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { type EntryFacts, readEntryFacts, recheckEntries, recheckLink, reuseBankEntry, type StaleEntry } from "../cas/bank-entries";
import { abs, add, dec, format, mul } from "../cas/decimal";
import { type Mapping, mapStatement } from "../cas/mapping";
import {
  bankCandidates,
  bankMatches,
  closingUnits,
  day,
  engineTimeZone,
  fundRef,
  fundRefs,
  type FundRefs,
  type FundUnits,
  giftEntries,
  importRows,
  indexActivities,
  localDay,
  openingUnits,
  planImport,
  type PlannedTransaction,
  RECORD_PREFIX,
  rowsOf,
  sameUnits,
  statementDay,
} from "../cas/plan";
import {
  bankMovements,
  bankPairs,
  breakdown,
  type DuplicateState,
  fundGroups,
  MOVEMENT,
  plannedOf,
  rowUnits,
  sends,
  unitsDiffer,
  type Waiting,
} from "../cas/review";
import type { CasData, CasFolio, CasScheme } from "../cas/types";
import { type Ignored, NewAccountLine, type Proposed, type Renaming } from "../components/account-choices";
import type { AmfiCheck } from "../components/amfi-banner";
import { type FundChoice, type FundItem, fundItems } from "../components/fund-choices";
import { type NotCreated, NotCreatedAlert } from "../components/holdings-preview";
import {
  ActivityTable,
  type BankLink,
  type ClosingCheck,
  importIds,
  type ImportOutcome,
  ImportResult,
  linkWords,
  outcomeWords,
  staleText,
} from "../components/preview";
import { BankCheck, type BankCheckModel, checkReceipt, paid } from "../components/review/bank-check";
import { AskAnswered, AskCard } from "../components/review/asks";
import { type EarlierFund, type LeftOutFund, NotIncludedDetailed, nothingWords, TransactionsSummary } from "../components/review/detailed-parts";
import { useReviewFocus } from "../components/review/focus";
import { Footer } from "../components/review/footer";
import { type FundRow, type FundRowHandlers, FundsReadyTable } from "../components/review/funds-ready";
import { ReviewHeader } from "../components/review/header";
import { SearchDown } from "../components/review/trouble";
import { Disclosure, LinkButton, shownName, useWide, WrapButton } from "../components/review/parts";
import { AnsweredLine, answerWords, Picker, pickerIds, QuestionCard } from "../components/review/question";
import { folioName, type FundsBox, SaveToDetailed } from "../components/review/save-to-detailed";
import { useHoldingSearches } from "../components/review/search";
import { bankKey, type ChosenFund, folioKey, fundKey, LEFT_OUT, NO_BANK, panKey } from "../lib/choices";
import { readableName } from "../lib/fund-name";
import { explanation, Explained } from "../lib/explained";
import { instrumentType } from "../lib/instrument-type";
import { nameNumber } from "../lib/name-number";
import { isProposed, nameProblem, newAccount, proposalKey, proposedId, proposedNames } from "../lib/new-accounts";
import { plural } from "../lib/plural";
import { longDate, rupees, units } from "../lib/review-format";
import { type AskWords } from "../lib/asks";
import { sha256 } from "../lib/sha256";

type Busy = "" | "preview" | "import" | "check";

/** What the import did, shown in place of the review until Phase 3's Done screen. */
interface Imported {
  /** Every row Wealthfolio answered for, over the import and each retry. */
  result: ImportActivitiesResult;
  sent: ActivityImport[];
  /** The transactions the review approved. */
  parts: Part[];
  /** Those that went in. */
  done: ReadonlySet<Part>;
  /** Those that wait: for an account Wealthfolio didn't create, or because it didn't import them. */
  held: Part[];
  closing: ClosingCheck;
  links: BankLink[];
}

const EMPTY: ImportActivitiesResult = {
  activities: [],
  importRunId: "",
  summary: { total: 0, imported: 0, skipped: 0, duplicates: 0, assetsCreated: 0, success: true },
};
const RECHECK_FAILED = "We couldn't check the bank entries you chose again, so nothing was imported.";
const IMPORT_FAILED = "Nothing was imported: Wealthfolio couldn't import the transactions.";

/** Two imports' results as one: the counts added up, every row listed. */
function mergeResults(a: ImportActivitiesResult, b: ImportActivitiesResult): ImportActivitiesResult {
  const sum = (field: "total" | "imported" | "skipped" | "duplicates" | "assetsCreated") => (a.summary[field] ?? 0) + (b.summary[field] ?? 0);
  const failed = [a, b].find((r) => !r.summary.success);
  return {
    ...b,
    activities: [...a.activities, ...b.activities],
    summary: {
      ...b.summary,
      total: sum("total"),
      imported: sum("imported"),
      skipped: sum("skipped"),
      duplicates: sum("duplicates"),
      assetsCreated: sum("assetsCreated"),
      // Each part's rows say what went wrong; the summary says whether any of it went in.
      success: a.summary.success || b.summary.success,
      ...(failed && !(a.summary.success || b.summary.success) ? { errorMessage: (failed.summary as { errorMessage?: string }).errorMessage } : {}),
    },
  };
}

/** A transaction the import sends, with the rows it sends: all of it, or none. */
interface Part {
  t: PlannedTransaction;
  rows: ActivityImport[];
  /** The bank entry its cash links to instead of a new transfer, as the review showed it. */
  entry?: { row: ActivityDetails; facts: EntryFacts };
}

/** What the automatic plan found from Wealthfolio's activities and the review's choices. */
interface Prepared {
  /** The choices it was worked out from. */
  signature: string;
  /** The destinations, funds and host reads its question evidence belongs to. */
  questionSignature: string;
  existing: ActivityDetails[];
  funds: FundRefs;
  timeZone: string;
  mapping: Mapping;
  plan: PlannedTransaction[];
  /** Bank transfers already linked with another, which can't be used. */
  linked: Set<string>;
  /** What linking each bank entry changes, by its ID. */
  facts: Map<string, EntryFacts>;
  /** Each fund's opening units against what Wealthfolio holds before the statement. */
  opening: FundUnits[];
}

/** The bank entries and consequences seen when the check was answered, before later refreshes. */
interface BankAnswer {
  linked: boolean;
  signature: string;
  shown: ReadonlyMap<string, { entry: ActivityDetails; facts: EntryFacts }>;
}

/** A fund's Change, open in place. */
interface Editor {
  rowId: string;
  itemKey: string;
  name: string;
}

export interface DetailedRemembered {
  accounts: [string, string][];
  funds: [string, FundChoice][];
}

/** A folio's scheme, as a mapping warning names it. */
const schemeKey = (folio: string, scheme: string) => JSON.stringify([folio, scheme]);
const REGISTRARS: Record<string, string> = { CAMS: "CAMS", KFINTECH: "KFintech" };
const CANT_PLAN = "We couldn't work out what will be saved. Nothing was saved.";
const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2019-04-01" → "Apr 2019". */
const month = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
/** The planned transaction's own key, which stays the same as the plan is worked out again. */
const transactionKey = (t: PlannedTransaction) => t.transaction.activity.sourceRecordId ?? `line:${t.transaction.activity.lineNumber}`;
const canImportAnyway = (t: PlannedTransaction) => !t.transaction.arriving && t.status === "duplicate";
/** A duplicate answer belongs to its matched rows, including what Wealthfolio says about them. */
function duplicateEvidence({ plan, existing, timeZone }: Prepared) {
  const byId = new Map(existing.map((a) => [a.id, a]));
  const byLine = new Map(plan.flatMap((t) => t.rows.map(({ activity }) => [activity.lineNumber, activity.sourceRecordId] as const)));
  const repeated = (line: number | undefined) => line === undefined ? undefined : byLine.get(line) ?? line;
  return new Map(plan.filter(canImportAnyway).map((t) => [transactionKey(t), JSON.stringify([
    timeZone,
    t.rows.map(({ activity, repeatsLine, duplicateOfLineNumber, ...row }) => {
      // Answering an unrelated units question can renumber the same statement rows.
      const { lineNumber: _, ...values } = activity;
      return [values, row, repeated(repeatsLine), repeated(duplicateOfLineNumber), byId.get(row.existingId ?? row.duplicateOfId ?? "")];
    }),
  ])]));
}
/** A transaction's movement in words: "purchase", "sale". */
const noun = (t: PlannedTransaction, accountId = t.transaction.activity.accountId) => {
  const received = t.transaction.receiving?.activity;
  const activity = received?.accountId === accountId ? received : t.transaction.activity;
  return (MOVEMENT[t.transaction.rows[0].type] ?? activityLabel(activity)).toLowerCase();
};
const LABELS: Record<string, string> = {
  BUY: "Purchase", SELL: "Sale", DIVIDEND: "Dividend", TRANSFER_IN: "Gift received", TRANSFER_OUT: "Gift given", ADJUSTMENT: "Merger",
};
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const activityLabel = (row: ActivityImport) => (row.activityType === "DIVIDEND" && row.subtype === "DRIP" ? "Reinvested dividend" : LABELS[row.activityType] ?? row.activityType);
/** A statement row's movement as the statement words it: "purchase", "redemption", "cash dividend". */
const STATEMENT_WORDS: Record<string, string> = {
  PURCHASE: "purchase", PURCHASE_SIP: "SIP purchase", REDEMPTION: "redemption", SWITCH_IN: "switch in", SWITCH_IN_MERGER: "switch in",
  SWITCH_OUT: "switch out", SWITCH_OUT_MERGER: "switch out", DIVIDEND_PAYOUT: "cash dividend", DIVIDEND_REINVEST: "reinvested dividend",
};
/** A transaction's movement as the statement words it, else as the Review screen does. */
const statementWord = (t: PlannedTransaction, accountId?: string) => STATEMENT_WORDS[t.transaction.rows[0].type] ?? noun(t, accountId);
/** Wealthfolio's names for an activity's type, as its activity list shows them. */
const WEALTHFOLIO_TYPES: Record<string, string> = {
  BUY: "Buy", SELL: "Sell", DIVIDEND: "Dividend", INTEREST: "Interest", DEPOSIT: "Deposit", WITHDRAWAL: "Withdrawal",
  TRANSFER_IN: "Transfer in", TRANSFER_OUT: "Transfer out", ADJUSTMENT: "Adjustment", FEE: "Fee", TAX: "Tax", SPLIT: "Split",
};

/** A question only some detailed imports ask: a possible duplicate, or a fund whose rows don't add up. */
interface Ask {
  id: string;
  words: AskWords;
  /** Its evidence, in place of `words.line` where that's more than a line. */
  evidence?: ReactNode;
  /** After the visible label, what its buttons act on. */
  target: string;
  /** True for the main (safe) answer, false for the other; undefined until answered. */
  answer: boolean | undefined;
  /** The other answer is one to check, as importing rows that don't add up is. */
  warn?: boolean;
  /** The fund it's about, for a fund whose rows don't add up. */
  fundKey?: string;
  set: (answer: boolean | undefined) => void;
}

/**
 * A detailed CAMS or KFintech statement on one Review screen: where its transactions go, what needs
 * an answer, what will be imported and what won't, and one button. The plan is worked out again as the
 * answers settle. Nothing is remembered until the import or Finish, so Use another file discards it all.
 */
export function DetailedImport({
  ctx,
  statement,
  data,
  fileName,
  accounts,
  allAccounts,
  accountChoices,
  unavailable,
  fundChoices,
  amfi,
  visit,
  busy,
  setBusy,
  onRemember,
  onCreated,
  onAnother,
}: {
  ctx: AddonContext;
  /** The statement as read, for its summary. */
  statement: CasData;
  /** Without closed schemes, with readable names. */
  data: CasData;
  fileName: string;
  /** Active, unarchived accounts. */
  accounts: Account[];
  allAccounts: Account[];
  /** Remembered choices of active, unarchived accounts, or `LEFT_OUT` or `NO_BANK`. */
  accountChoices: Record<string, string>;
  /** Remembered choices of hidden, archived or missing accounts, ignored: key → the account. */
  unavailable: Record<string, Ignored>;
  /** Remembered fund choices. */
  fundChoices: Record<string, FundChoice | undefined>;
  amfi: AmfiCheck;
  /** The page's route location, new each time the page is opened again. */
  visit: unknown;
  busy: Busy;
  setBusy: (busy: Busy) => void;
  onRemember: (remembered: DetailedRemembered) => void;
  /** Adds the accounts the import created to the page's accounts. */
  onCreated: (accounts: Account[]) => void;
  /** Leaves the review for the file form; `notice` says what happened. */
  onAnother: (notice?: string) => void;
}) {
  const { api } = ctx;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const id = (part: string) => `${uid}-${part.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  // Wealthfolio values an account that tracks holdings from its snapshots alone, so transactions go to
  // the others, which include NOT_SET.
  const targets = accounts.filter((a) => a.trackingMode !== "HOLDINGS");
  // The accounts this review created, by proposed ID: importing again goes into them, never creating another.
  const created = useRef(new Map<string, Account>());
  function accountName(accountId: string) {
    const account = created.current.get(accountId);
    if (account) return account.name;
    if (isProposed(accountId)) return proposalNames.get(proposalKey(accountId)) ?? "";
    return allAccounts.find((a) => a.id === accountId)?.name ?? [...created.current.values()].find((a) => a.id === accountId)?.name ?? "the bank account";
  }
  const accountLabel = (accountId: string) =>
    isProposed(accountId) ? accountName(accountId) : `${accountName(accountId)}${nameNumber(allAccounts, allAccounts.findIndex((a) => a.id === accountId), "account")}`;

  // Who each folio belongs to: a box per PAN, and one per folio printed without a PAN.
  const boxes = useMemo(() => {
    const found: FundsBox[] = [];
    for (const folio of data.folios) {
      if (!folio.PAN) {
        found.push({
          key: folioKey(folio),
          name: folio.name?.trim() || data.investor_info.name?.trim() || "This investor",
          title: `${folioName(folio)} (no PAN printed)`,
          folios: [folio],
          pan: false,
        });
        continue;
      }
      const key = panKey(folio.PAN);
      const box = found.find((b) => b.key === key);
      if (box) box.folios.push(folio);
      else found.push({ key, name: folio.name?.trim() || "", title: "", folios: [folio], pan: true });
    }
    const pans = found.filter((b) => b.pan);
    for (const box of pans) {
      box.name ||= pans.length === 1 ? data.investor_info.name?.trim() || "This investor" : `PAN ${box.folios[0].PAN}`;
      box.name = box.name.replace(/\s+/g, " ");
    }
    for (const box of pans) {
      const same = pans.filter((b) => b.name === box.name).length > 1;
      box.title = `${box.name}${same ? ` (PAN ${box.folios[0].PAN})` : ""}'s funds`;
    }
    return found;
  }, [data]);
  const boxOf = (folio: CasFolio) => boxes.find((b) => b.folios.includes(folio))!;
  const boxKeys = new Set(boxes.map((b) => b.key));
  const boxBankKeys = new Set(boxes.map((b) => bankKey(b.key)));

  // A new account each funds' select offers, created when the transactions are imported: "Mutual
  // funds" for the first box, with its investor's name for the others, and each of a PAN's folios
  // its own, named after it.
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  // Names an import tried and couldn't create, kept while the created accounts take theirs.
  const tried = useRef<Record<string, string>>({});
  const proposalNames = proposedNames(
    [
      ...boxes.map((box, i) => ({ key: box.key, base: "Mutual funds", who: i ? box.name : undefined })),
      ...boxes.filter((b) => b.pan).flatMap((b) => b.folios.map((f) => ({ key: folioKey(f), base: folioName(f) }))),
    ],
    allAccounts.map((a) => a.name),
    { ...tried.current, ...renamed },
  );
  const proposed = (key: string): Proposed => ({ id: proposedId(key), name: proposalNames.get(key) ?? "" });
  // Accounts this review creates don't change what it preselected.
  const proposeNew = useRef(targets.length === 0).current;

  // Like a hidden, archived or missing one, a remembered account that tracks holdings is ignored, and
  // its row says why.
  const usable = Object.fromEntries(
    Object.entries(accountChoices).filter(([key, value]) =>
      key.startsWith("bank-") ? value === NO_BANK || targets.some((a) => a.id === value) : value === LEFT_OUT || targets.some((a) => a.id === value)),
  );
  const ignored: Record<string, Ignored> = {
    ...unavailable,
    ...Object.fromEntries(
      Object.entries(accountChoices).flatMap(([key, value]) => {
        const found = accounts.find((a) => a.id === value && a.trackingMode === "HOLDINGS");
        return found ? [[key, { name: found.name }]] : [];
      }),
    ),
  };

  const items = useMemo(() => fundItems(data), [data]);
  const itemOf = new Map(items.map((item) => [item.key, item]));
  const labelOf = new Map(items.map((item, i) => [item.key, `${item.name.trim()}${nameNumber(items, i, item.noun)}`]));

  // The review's own choices, over the remembered ones.
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, FundChoice | undefined>>({});
  const [matched, setMatched] = useState<Record<string, ChosenFund>>({});
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  // Answers to the rare questions: skip (true) or import a possible duplicate, by its transaction's
  // key, and skip (true) or import a fund whose rows don't add up, by its folio's scheme.
  const [duplicateAnswers, setDuplicateAnswers] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [unbalancedAnswers, setUnbalancedAnswers] = useState<ReadonlyMap<string, boolean>>(new Map());
  const importsUnbalanced = (key: string) => unbalancedAnswers.get(key) === false;
  // Each bank check's answer and ticks, for the pairs they were given for.
  const [checkAnswers, setCheckAnswers] = useState<Record<string, BankAnswer>>({});
  const [ticks, setTicks] = useState<Record<string, { signature: string; keys: string[]; changed: boolean }>>({});
  const [showAll, setShowAll] = useState(false);
  const [open, setOpenState] = useState<Record<string, boolean>>({});
  const setOpen = (key: string, yes: boolean) => setOpenState((all) => ({ ...all, [key]: yes }));
  const [editor, setEditor] = useState<Editor | null>(null);
  const [nag, setNag] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  // The plan couldn't be worked out: with the add-on's own explanation, if it has one.
  const [prepareError, setPrepareError] = useState<{ why: string } | null>(null);
  const [imported, setImportedState] = useState<Imported | null>(null);
  // The latest result, for Try again, which goes on from it.
  const latestImported = useRef<Imported | null>(null);
  const setImported = (next: Imported) => {
    latestImported.current = next;
    setImportedState(next);
  };
  // Accounts the last import couldn't create; it imported nothing else, so the review stays.
  const [notCreated, setNotCreated] = useState<NotCreated[]>([]);
  const [stale, setStale] = useState<StaleEntry[] | null>(null);
  const [error, setError] = useState("");
  // Bumped when the page is opened again or bank entries changed: Wealthfolio may have changed meanwhile.
  const [generation, setGeneration] = useState(0);
  const wide = useWide();
  const { said, announce, focusSoon } = useReviewFocus();

  // Each choice as its select shows it: an account ID, `LEFT_OUT`, `NO_BANK`, "" for Same as above or
  // None, null for none yet.
  const valueOf = (key: string): string | null => {
    if (key in picks) return picks[key];
    if (key in ignored) return null;
    const value = usable[key];
    if (value !== undefined) return boxBankKeys.has(key) && value === NO_BANK ? "" : value;
    // With no account that tracks transactions when the review starts, each box's new one is chosen.
    return boxKeys.has(key) ? (proposeNew ? proposedId(key) : null) : "";
  };
  /** Where a folio's transactions go: an account, `LEFT_OUT`, or undefined until chosen. */
  const folioAccount = (folio: CasFolio, value = valueOf) => {
    const own = value(folioKey(folio));
    if (!folio.PAN || own === null) return own || undefined;
    return own || value(panKey(folio.PAN)) || undefined;
  };
  const accountOf = (folio: CasFolio) => {
    const to = folioAccount(folio);
    return to && to !== LEFT_OUT ? to : undefined;
  };
  /** The bank choice that sets the folio's bank account, and its value. */
  const bankChoiceOf = (folio: CasFolio, value = valueOf) => {
    const own = bankKey(folioKey(folio));
    const mine = value(own);
    if (folio.PAN && mine === "") return { key: bankKey(panKey(folio.PAN)), value: value(bankKey(panKey(folio.PAN))) };
    return { key: own, value: mine };
  };
  /** The folio's bank account; undefined for none, null until chosen again. */
  const bankOf = (folio: CasFolio, value = valueOf) => {
    const chosen = bankChoiceOf(folio, value).value;
    return chosen === null ? null : !chosen || chosen === NO_BANK ? undefined : chosen;
  };
  /** Whether a folio is imported, left out, or waits for an account or bank account. */
  const folioState = (folio: CasFolio, value = valueOf) => {
    const to = folioAccount(folio, value);
    if (to === LEFT_OUT) return "out";
    const bank = bankOf(folio, value);
    if (!to || bank === null) return "undecided";
    return bank === to ? "conflict" : "ok";
  };
  const undecidedFolios = data.folios.filter((f) => folioState(f) === "undecided" || folioState(f) === "conflict");
  const conflicts = new Set(data.folios.filter((f) => folioState(f) === "conflict").map((f) => bankChoiceOf(f).key));
  const accountQuestion = undecidedFolios.length > 0;

  const choiceOf = (key: string): FundChoice | undefined =>
    key in answers ? answers[key] : matched[key] ? { fund: matched[key] } : fundChoices[key];
  const fundOf = (key: string) => {
    const choice = choiceOf(key);
    return choice && "fund" in choice ? choice.fund : undefined;
  };
  const foliosOf = (key: string) => data.folios.filter((f) => f.schemes.some((s) => fundKey(s) === key));
  const fundNameOf = (key: string) => shownName(itemOf.get(key)!, fundOf(key));
  const included = (folio: CasFolio) => folioAccount(folio) !== LEFT_OUT;

  // Funds that need an answer: in a folio that's imported, or whose account isn't chosen yet, and with
  // no fund confirmed.
  const questionKeys = items.filter((item) => !choiceOf(item.key) && foliosOf(item.key).some(included)).map((item) => item.key);
  const changing = editor?.itemKey;
  const changingRef = useRef(changing);
  changingRef.current = changing;
  const searches = useHoldingSearches(ctx, items, {
    wanted: changing && !questionKeys.includes(changing) ? [...questionKeys, changing] : questionKeys,
    handled,
    amfiSearches: amfi.searches,
    onMatch: (key, fund) => {
      if (!choiceOf(key)) setMatched((all) => ({ ...all, [key]: fund }));
    },
    // The focus goes to what the search found, without using or picking it; a failed one leaves it in the box.
    onTyped: (key, outcome) => {
      const picker = pickerIds(changingRef.current === key ? id(`picker-change-${key}`) : id(`picker-${key}`));
      if ("error" in outcome || !outcome.found) {
        focusSoon(picker.field, false, outcome.origin);
        return announce("error" in outcome ? "The search didn't work." : `Nothing found for “${outcome.text}”. Check the code.`);
      }
      if (outcome.total === 1) {
        focusSoon(picker.single, false, outcome.origin);
        announce("1 result found. Use it to continue.");
      } else {
        focusSoon(picker.firstTyped, false, outcome.origin);
        announce(`${plural(outcome.found, "result")} found. Choose one to continue.`);
      }
    },
  });
  // A question shows once its first search is done, so funds AMFI confirms don't flash up as questions.
  const searched = useRef(new Set<string>());
  for (const { key } of items) {
    const auto = searches.get(key).auto;
    if (auto && auto.status !== "searching") searched.current.add(key);
  }
  const lookingUp = questionKeys.filter((key) => !searched.current.has(key));
  const openKeys = questionKeys.filter((key) => searched.current.has(key));

  /** The account, fund and bank account of a folio's scheme, once all are chosen. */
  const target = (folio: CasFolio, scheme: CasScheme) => {
    const fund = fundOf(fundKey(scheme));
    if (!fund || folioState(folio) !== "ok") return undefined;
    return { accountId: accountOf(folio)!, asset: fund, bankAccountId: bankOf(folio) ?? undefined };
  };

  // The automatic plan: worked out again whenever the accounts, funds or chosen funds that don't add up
  // change, from reads of Wealthfolio cached until the page is opened again.
  const cache = useRef({ reads: new Map<string, Promise<unknown>>() });
  const firstVisit = useRef(true);
  useEffect(() => {
    if (firstVisit.current) {
      firstVisit.current = false;
      return;
    }
    cache.current = { reads: new Map() };
    setGeneration((n) => n + 1);
  }, [visit]);
  const destinations = data.folios.map((f) => [folioState(f), accountOf(f) ?? "", bankOf(f) ?? ""]);
  const questionSignature = JSON.stringify([
    generation,
    // Creating the chosen account doesn't change the question the user answered.
    destinations.map(([state, account, bank]) => [state, [...created.current].find(([, a]) => a.id === account)?.[0] ?? account, bank]),
    items.map((item) => fundOf(item.key) ?? null),
  ]);
  // A different destination, fund or refreshed host needs new answers to its evidence.
  useEffect(() => {
    setDuplicateAnswers(new Map());
    setUnbalancedAnswers(new Map());
  }, [questionSignature]);
  const [attempt, setAttempt] = useState(0);
  const signature = JSON.stringify([
    questionSignature,
    destinations,
    attempt,
    [...unbalancedAnswers].filter(([key]) => importsUnbalanced(key)).map(([key]) => key).sort(),
  ]);
  // Try again stays, busy, while the plan is worked out again, so its focus does too; once it's worked
  // out, the focus goes to the bar's summary, unless the user moved it meanwhile.
  const [retrying, setRetrying] = useState(false);
  const retryFrom = useRef<Element | null>(null);
  const settleRetry = (ok: boolean) => {
    const from = retryFrom.current;
    retryFrom.current = null;
    setRetrying(false);
    if (ok && from) focusSoon(id("summary"), false, from);
  };
  const latestPrepare = useRef(0);
  useEffect(() => {
    if (imported) return;
    const run = ++latestPrepare.current;
    setPrepareError(null);
    prepare(signature).then(
      (next) => {
        if (run !== latestPrepare.current) return;
        const before = prepared && duplicateEvidence(prepared);
        const after = duplicateEvidence(next);
        setDuplicateAnswers((all) => new Map([...all].filter(([key]) => after.has(key) && before?.get(key) === after.get(key))));
        setPrepared(next);
        settleRetry(true);
      },
      (e) => {
        if (run !== latestPrepare.current) return;
        api.logger.error(`Couldn't work out what will be imported: ${String(e)}`);
        const why = explanation(e);
        setPrepareError({ why });
        announce(`${CANT_PLAN}${why ? ` ${why}` : ""}`);
        settleRetry(false);
      },
    );
  }, [signature]);
  const current = prepared?.signature === signature ? prepared : null;

  async function prepare(signature: string): Promise<Prepared> {
    const { reads } = cache.current;
    const once = <T,>(key: string, read: () => Promise<T>): Promise<T> => {
      if (!reads.has(key)) {
        const promise = read();
        reads.set(key, promise);
        promise.catch(() => reads.delete(key));
      }
      return reads.get(key) as Promise<T>;
    };
    // Groups span accounts; shortcut: the host hides archived activities until its search API includes them.
    const existing = await once("activities", () => api.activities.getAll());
    const timeZone = await once("timezone", () => engineTimeZone(api.settings));
    const funds = await fundsIn(existing, (assetId) => once(`profile:${assetId}`, () => api.assets.getProfile(assetId)));
    // A fund that starts with units needs Wealthfolio to hold exactly those before the statement.
    const opening = openingUnits(data, target, existing, funds, timeZone);
    const covered = new Set(opening.filter(sameUnits).flatMap((f) => f.schemes));
    const entered = giftEntries(existing, funds, timeZone);
    const mapping = mapStatement(data, {
      target: (folio, scheme) => {
        const t = target(folio, scheme);
        return t && { ...t, openingCovered: covered.has(scheme), importUnbalanced: importsUnbalanced(schemeKey(folio.folio, scheme.scheme)) };
      },
      alreadyImported: indexActivities(existing, funds).has,
      entered: (row) => entered(row).length > 0,
    });
    const rows = rowsOf(mapping);
    // Wealthfolio checks rows against their account, so rows for an account still to create are
    // checked once it's created, just before they're imported. Until then they're new, as an
    // account with no activities has them.
    const known = rows.filter((row) => !isProposed(row.accountId));
    const checkedKnown = known.length ? await once(`check:${sha256(JSON.stringify(known))}`, () => api.activities.checkImport(known)) : [];
    let at = 0;
    const checked = rows.map((row) => (isProposed(row.accountId) ? { ...row, isValid: true } : checkedKnown[at++]));
    const plan = planImport(mapping, existing, checked, funds, timeZone);
    // A bank transfer already linked to another can't be used.
    const candidates = [...new Map(plan.flatMap((t) => bankCandidates(t, existing)).map((a) => [a.id, a])).values()];
    const linked = new Set<string>();
    await Promise.all(
      candidates.filter((a) => a.activityType.startsWith("TRANSFER")).map(async (a) => {
        if (await once(`pair:${a.id}`, () => api.activities.getTransferPair(a.id))) linked.add(a.id);
      }),
    );
    const entries = candidates.filter((a) => !linked.has(a.id));
    const facts = entries.length
      ? await once(`facts:${entries.map((a) => a.id).sort().join(",")}`, () => readEntryFacts(api, entries))
      : new Map<string, EntryFacts>();
    return { signature, questionSignature, existing, funds, timeZone, mapping, plan, linked, facts, opening };
  }

  // Which confirmed fund each asset of `activities` is. A fund without an asset ID goes by the symbol
  // and exchange on each asset's profile; one with an ID needs its asset to still have the symbol,
  // exchange and type its rows are imported with. Either match needs the import's type.
  async function fundsIn(
    activities: ActivityDetails[],
    profileOf: (assetId: string) => Promise<Awaited<ReturnType<typeof api.assets.getProfile>>>,
    targetOf: typeof target = target,
  ) {
    const chosen = data.folios.flatMap((f) => f.schemes.flatMap((s) => targetOf(f, s) ?? []));
    const funds = chosen.map((t) => t.asset);
    const accountIds = new Set(chosen.map((t) => t.accountId));
    const ids = new Set(funds.flatMap((f) => (f.assetId ? [f.assetId] : [])));
    if (funds.some((f) => !f.assetId)) {
      for (const a of activities) if (a.assetId && accountIds.has(a.accountId)) ids.add(a.assetId);
    }
    const profiles = new Map(
      await Promise.all(
        [...ids].map(async (assetId) => {
          try {
            return [assetId, await profileOf(assetId)] as const;
          } catch (e) {
            api.logger.error(`Couldn't read a Wealthfolio asset's profile: ${String(e)}`);
            throw new Explained(
              "A fund's asset couldn't be read in Wealthfolio. If it was deleted there, choose Change beside its fund and pick its replacement.",
            );
          }
        }),
      ),
    );
    const refs = fundRefs(funds, new Map([...profiles].map(([assetId, p]) => [assetId, fundRef(p.instrumentSymbol ?? "", p.instrumentExchangeMic)])));
    const byFund = new Map([...refs].map(([assetId, ref]) => [ref, assetId]));
    for (const f of funds) {
      const assetId = f.assetId || byFund.get(fundRef(f.symbol, f.exchangeMic));
      if (!assetId) continue;
      const profile = profiles.get(assetId)!;
      if (!profile.instrumentType) {
        throw new Explained(`The type of ${f.name} isn't set in Wealthfolio. Set its type there, then choose Change beside the fund and confirm it again.`);
      }
      if (
        fundRef(profile.instrumentSymbol ?? "", profile.instrumentExchangeMic) !== fundRef(f.symbol, f.exchangeMic) ||
        instrumentType(profile.instrumentType) !== instrumentType(f.instrumentType)
      ) {
        throw new Explained(`The symbol, exchange or type of ${f.name} changed in Wealthfolio. Choose Change beside the fund and confirm it again.`);
      }
    }
    return refs;
  }

  // What the plan sends, and what the review says about it.
  const plan = current?.plan ?? [];
  const planned = plannedOf(plan);
  // A possible duplicate is asked about: some of its rows equal what Wealthfolio has or another row of
  // this statement, or Wealthfolio's check flags it. One Wealthfolio has all of, by its row IDs or by
  // value, as an older import or one entered by hand, was imported before; a merger's isn't forced.
  const forced = (t: PlannedTransaction) => canImportAnyway(t) && duplicateAnswers.get(transactionKey(t)) === false;
  /** What became of each possible duplicate, for the transactions' counts. */
  const duplicateState = (t: PlannedTransaction): DuplicateState | undefined => {
    if (!canImportAnyway(t)) return t.status === "duplicate" ? "never" : undefined;
    const answer = duplicateAnswers.get(transactionKey(t));
    return answer === undefined ? "open" : answer ? "skipped" : "imported";
  };
  const sentOf = (t: PlannedTransaction) => sends(t, forced);
  const sentPlan = plan.filter(sentOf);
  /** Each transaction's own folio: the one its first row is in. */
  const folioOfTransaction = new Map(
    (current?.mapping.outcomes ?? []).filter((o) => o.transaction && o.row === o.transaction.rows[0]).map((o) => [o.transaction!, o.folio]),
  );

  // The bank entries that may be transactions' bank sides, one check per box and bank account, shown
  // under the bank choice that set it.
  const matches = current ? bankMatches(sentPlan, current.existing, current.linked) : new Map<PlannedTransaction, ActivityDetails>();
  const pairs = current
    ? bankPairs({
        transactions: sentPlan.filter((t) => t.transaction.bank),
        matches,
        existing: current.existing,
        linked: current.linked,
        facts: current.facts,
        amcOf: (t) => folioOfTransaction.get(t.transaction)?.amc ?? "",
      })
    : [];
  const checks: BankCheckModel[] = [];
  for (const pair of pairs) {
    const folio = folioOfTransaction.get(pair.t.transaction)!;
    const box = boxOf(folio);
    const bankId = pair.t.transaction.bank!.accountId;
    const boxBank = valueOf(bankKey(box.key));
    const anchor = boxBank === bankId
      ? bankKey(box.key)
      : bankChoiceOf(box.folios.find((f) => folioState(f) === "ok" && bankOf(f) === bankId)!).key;
    let check = checks.find((c) => c.id.startsWith(`${box.key}|`) && c.bankId === bankId);
    if (!check) {
      check = {
        id: `${box.key}|${bankId}`, anchor, bankId, bankName: accountName(bankId),
        label: `${box.title} · ${accountLabel(bankId)}`,
        pairs: [], signature: "",
      };
      checks.push(check);
    }
    check.pairs.push(pair);
  }
  for (const check of checks) check.signature = check.pairs.map((p) => p.key).sort().join("\n");
  const tickedOf = (check: BankCheckModel) => {
    const own = ticks[check.id];
    return new Set(own && own.signature === check.signature ? own.keys : check.pairs.filter((p) => p.strong).map((p) => p.key));
  };
  const answerOf = (check: BankCheckModel) => {
    const answer = checkAnswers[check.id];
    return answer && answer.signature === check.signature ? answer : undefined;
  };
  // Keep the starting ticks when evidence changes; different pairs need a fresh selection and answer.
  useEffect(() => {
    const changed = checks.filter((c) => ticks[c.id]?.signature !== c.signature);
    if (!changed.length) return;
    setTicks((all) => {
      let next = all;
      for (const check of changed) {
        if (next[check.id]?.signature === check.signature) continue;
        next = { ...next, [check.id]: { signature: check.signature, keys: check.pairs.filter((p) => p.strong).map((p) => p.key), changed: false } };
      }
      return next;
    });
    setCheckAnswers((all) => {
      let next = all;
      for (const check of changed) {
        if (!next[check.id] || next[check.id].signature === check.signature) continue;
        const { [check.id]: _, ...rest } = next;
        next = rest;
      }
      return next;
    });
  });
  const openChecks = checks.filter((c) => !answerOf(c));
  const reusedKeys = new Set(checks.flatMap((c) => (answerOf(c)?.linked ? [...tickedOf(c)] : [])));
  const pairOf = new Map(pairs.map((p) => [p.t, p]));
  const reused = (t: PlannedTransaction) => {
    const pair = pairOf.get(t);
    return !!pair && reusedKeys.has(pair.key);
  };

  const blockedSchemes = new Set((current?.mapping.warnings ?? []).filter((w) => w.leftOut && w.rows.length === 0).map((w) => schemeKey(w.folio, w.scheme)));
  // Each fund in each account, with its transactions and units from the planned transactions.
  const groups = current
    ? fundGroups({ data, mapping: current.mapping, planned, sent: sentOf, target, existing: current.existing, funds: current.funds, timeZone: current.timeZone })
    : [];
  const multiBox = boxes.length > 1;
  const rows: FundRow[] = groups.filter((g) => g.sent > 0).map((group) => {
    const keys = [...new Set(group.schemes.map((s) => fundKey(s.scheme)))];
    const item = itemOf.get(keys[0])!;
    const fund = fundOf(item.key)!;
    const names = [...new Set(group.schemes.map((s) => boxOf(s.folio).name))];
    let note: string | undefined;
    if (unitsDiffer(group)) {
      const why = group.unbalanced
        ? "Imported with the difference you accepted."
        : group.forced
          ? group.forced === 1
            ? `Includes the second ${statementWord(sentPlan.find((t) => t.status !== "new" && groupsOfTransaction(t).includes(group.key))!, group.accountId)} you chose.`
            : `Includes the ${group.forced} possible duplicates you chose.`
          : group.other
            ? `${plural(group.other, "transaction")} of this fund ${group.other === 1 ? "isn't" : "aren't"} imported now.`
            : "Wealthfolio's other transactions of this fund differ from the statement.";
      note = `After import: ${units(format(group.after!))} units · Statement: ${units(format(group.statement))}. ${why}`;
    }
    if (group.forced) {
      // A second cash dividend changes no units, only the income.
      const income = sentPlan.filter((t) => t.status !== "new" && groupsOfTransaction(t).includes(group.key) && rowUnits(t.transaction.activity) === undefined);
      if (income.length) {
        const amount = income.reduce((total, t) => add(total, abs(dec(String(t.transaction.activity.amount ?? t.transaction.cash?.amount ?? "0")))), dec("0"));
        const incomeNote = income.length === 1
          ? `Includes the second ${statementWord(income[0], group.accountId)} you chose: ${rupees(format(amount))} more income.`
          : `Includes ${income.length} possible duplicates you chose: ${rupees(format(amount))} more income.`;
        note = note ? `${note} ${incomeNote}` : incomeNote;
      }
    }
    return {
      id: group.key,
      group,
      groupTitle: multiBox ? `${list(names)} → ${accountName(group.accountId)}` : `To ${accountName(group.accountId)}`,
      item,
      items: keys.map((key) => itemOf.get(key)!),
      fund,
      by: item.key in answers ? "you" : matched[item.key] ? "auto" : "before",
      name: shownName(item, fund),
      label: "",
      unitsAfter: group.after === undefined ? undefined : units(format(group.after)),
      note,
      touched: keys.some((key) => touched.has(key)),
    };
  });
  function groupsOfTransaction(t: PlannedTransaction) {
    return [t.transaction.activity, t.transaction.receiving?.activity].flatMap((activity) =>
      activity ? [`${activity.accountId}|${fundRef(activity.symbol!, activity.exchangeMic)}`] : []);
  }
  rows.forEach((row, i) => {
    row.label = `${row.name.trim()}${nameNumber(rows, i, "fund")}`;
  });
  const readyKeys = new Set(rows.flatMap((r) => r.items.map((i) => i.key)));
  const nothingNew = groups.filter((g) => g.sent === 0 && g.other === 0 && !g.schemes.some(({ folio, scheme }) => blockedSchemes.has(schemeKey(folio.folio, scheme.scheme))));
  const nothingNewKeys = [...new Set(nothingNew.flatMap((g) => g.schemes.map((s) => fundKey(s.scheme))))].filter((key) => !readyKeys.has(key));
  const autoCount = new Set(rows.filter((r) => r.by === "auto").map((r) => r.item.key)).size;

  // What this import leaves out.
  const why = (folio: CasFolio, scheme: CasScheme): Waiting => {
    if (folioAccount(folio) === LEFT_OUT) return "notImported";
    const choice = choiceOf(fundKey(scheme));
    return choice && !("fund" in choice) ? "skipped" : "answers";
  };
  const counts = current
    ? breakdown({
        mapping: current.mapping, planned, sent: sentOf, why, duplicate: duplicateState,
        unbalancedAnswer: (folio, scheme) => (unbalancedAnswers.get(schemeKey(folio.folio, scheme.scheme)) ? false : undefined),
      })
    : undefined;
  const earlier: EarlierFund[] = (() => {
    if (!current) return [];
    const waiting = new Map<string, { schemes: CasScheme[]; count: number }>();
    for (const outcome of current.mapping.outcomes) {
      if (outcome.leftOut?.kind !== "opening") continue;
      const key = fundKey(outcome.scheme);
      const entry = waiting.get(key) ?? { schemes: [], count: 0 };
      if (!entry.schemes.includes(outcome.scheme)) entry.schemes.push(outcome.scheme);
      entry.count++;
      waiting.set(key, entry);
    }
    // A fund whose rows are only events still waits, with none of its transactions.
    for (const f of current.opening.filter((f) => !sameUnits(f))) {
      for (const scheme of f.schemes) {
        const key = fundKey(scheme);
        if (dec(scheme.open).n === 0n || waiting.get(key)?.schemes.includes(scheme)) continue;
        const entry = waiting.get(key) ?? { schemes: [], count: 0 };
        entry.schemes.push(scheme);
        waiting.set(key, entry);
      }
    }
    return [...waiting].map(([key, { schemes, count }]) => ({
      key,
      name: shownName(itemOf.get(key)!, fundOf(key)),
      units: `${units(format(schemes.reduce((total, s) => add(total, dec(s.open)), dec("0"))))} units`,
      waiting: count,
    }));
  })();
  const skipped = items.filter((item) => {
    const choice = choiceOf(item.key);
    return choice && !("fund" in choice) && foliosOf(item.key).some(included);
  });
  const notImported = data.folios.filter((f) => folioAccount(f) === LEFT_OUT);
  const leftOutFunds: LeftOutFund[] = (() => {
    if (!counts) return [];
    const byFund = new Map<string, LeftOutFund & { reasons: Map<string, string[]> }>();
    for (const { row, reason } of counts.leftOut) {
      const key = fundKey(row.scheme);
      const fund = byFund.get(key) ?? {
        key,
        name: shownName(itemOf.get(key)!, fundOf(key)),
        label: labelOf.get(key)!,
        lines: [],
        canChange: !!fundOf(key),
        reasons: new Map(),
      };
      const when = `${longDate(row.row.date)} · ${readableName(row.row.description).trim() || row.row.type}`;
      fund.reasons.set(reason, [...(fund.reasons.get(reason) ?? []), when]);
      byFund.set(key, fund);
    }
    return [...byFund.values()].map(({ reasons, ...fund }) => ({
      ...fund,
      lines: [...reasons].map(([reason, whens]) => ({ when: list(whens), reason })),
    }));
  })();

  // The questions only some imports ask, from the plan as last worked out, so a card stays while an
  // answer works the plan out again: funds whose rows don't add up, then possible duplicates.
  const shown = current ?? (prepared?.questionSignature === questionSignature ? prepared : null);
  const staleQuestions = shown?.questionSignature !== questionSignature;
  const shownById = new Map((shown?.existing ?? []).map((a) => [a.id, a]));
  const onDay = (date: Date | string | undefined) => {
    try {
      return longDate(localDay(date, shown?.timeZone ?? "UTC"));
    } catch {
      return String(date ?? "");
    }
  };
  function schemeOf(t: PlannedTransaction) {
    return shown?.mapping.outcomes.find((o) => o.transaction === t.transaction && o.row === t.transaction.rows[0])?.scheme;
  }
  const unbalancedWarnings = (shown?.mapping.warnings ?? []).filter((w) => w.unbalanced);
  const unbalancedAsks: Ask[] = unbalancedWarnings.map((w) => {
    const key = schemeKey(w.folio, w.scheme);
    const scheme = data.folios.find((f) => f.folio === w.folio)?.schemes.find((s) => s.scheme === w.scheme);
    const fund = scheme ? fundNameOf(fundKey(scheme)) : w.scheme;
    const twice = unbalancedWarnings.filter((other) => other.scheme === w.scheme).length > 1;
    const added = units(w.units?.added ?? "");
    const closing = units(w.units?.closing ?? "");
    return {
      id: `unbalanced|${key}`,
      words: {
        title: `${fund}'s transactions don't add up`,
        line: `${twice ? `In folio ${w.folio}, they` : "They"} add up to ${added} units; the statement says ${closing}. A row may be missing or misread.`,
        main: "Skip this fund",
        other: "Import with this difference",
        receipt: (skip) => `${fund}: ${skip ? "skipped" : "imported with the difference"}`,
        done: (skip) => `${fund} ${skip ? "skipped" : "imported with the difference"}, by your answer`,
      },
      target: twice ? `${fund}, folio ${w.folio}` : fund,
      fundKey: scheme && fundKey(scheme),
      answer: unbalancedAnswers.get(key),
      warn: unbalancedAnswers.get(key) === false,
      set: (answer) => setUnbalancedAnswers((all) => {
        const next = new Map(all);
        if (answer === undefined) next.delete(key);
        else next.set(key, answer);
        return next;
      }),
    };
  });
  const offered = (shown?.plan ?? []).filter(canImportAnyway);
  const duplicateAccounts = new Set<string>();
  const duplicateAsks: Ask[] = offered.map((t) => {
    const key = transactionKey(t);
    const { activity, rows: [first] } = t.transaction;
    const scheme = schemeOf(t);
    const fund = scheme ? fundNameOf(fundKey(scheme)) : t.transaction.scheme;
    const word = statementWord(t);
    const amountOf = (row: typeof first) => (row.amount ? rupees(format(abs(dec(row.amount)))) : undefined);
    const unitsOf = (row: typeof first) => (row.units && dec(row.units).n !== 0n ? `${units(format(abs(dec(row.units))))} units` : undefined);
    const statementLine = (row: typeof first) =>
      [longDate(row.date), capital(STATEMENT_WORDS[row.type] ?? row.type.toLowerCase()), fund, unitsOf(row), amountOf(row)].filter(Boolean).join(" · ");
    const row = t.rows.find((r) => r.existingId || r.repeatsLine !== undefined || r.flagged);
    const there = row && shownById.get(row.existingId ?? row.duplicateOfId ?? "");
    const account = accountName(there?.accountId ?? row?.activity.accountId ?? activity.accountId);
    duplicateAccounts.add(account);
    const repeated = row?.repeatsLine !== undefined && !there
      ? (shown?.plan ?? []).find((other) => other !== t && other.rows.some((r) => r.activity.lineNumber === row.repeatsLine))
      : undefined;
    const thereLine = there && (() => {
      const type = there.activityType === "DIVIDEND" && there.subtype === "DRIP" ? "Reinvested dividend" : WEALTHFOLIO_TYPES[there.activityType] ?? there.activityType;
      const amount = there.amount ?? (there.quantity && there.unitPrice ? format(mul(dec(String(there.quantity)), dec(String(there.unitPrice)))) : null);
      const how = there.sourceRecordId?.startsWith(RECORD_PREFIX) ? "imported by this add-on"
        : there.sourceSystem === "CSV" ? "imported from a file" : there.sourceRecordId ? "imported" : "entered by hand";
      return [
        onDay(there.date), type, there.assetName || there.assetSymbol || undefined,
        there.quantity && Number(there.quantity) !== 0 ? `${units(format(abs(dec(String(there.quantity)))))} units` : undefined,
        amount ? rupees(format(abs(dec(String(amount))))) : undefined,
        `${how}${there.createdAt ? ` on ${onDay(there.createdAt)}` : ""}`,
      ].filter(Boolean).join(" · ");
    })();
    const when = longDate(first.date);
    const money = amountOf(first);
    const evidence = (
      <>
        <p>
          <span className="text-foreground font-medium">On this statement:</span> {statementLine(first)}
        </p>
        <p>
          {repeated ? (
            <>
              <span className="text-foreground font-medium">Also on this statement:</span> {statementLine(repeated.transaction.rows[0])}
            </>
          ) : (
            <>
              <span className="text-foreground font-medium">Already in {account}:</span> {thereLine ?? "Wealthfolio reports an equal transaction there."}
            </>
          )}
        </p>
        <p>Two equal transactions on one day can both be real.</p>
      </>
    );
    return {
      id: `duplicate|${key}`,
      words: {
        title: repeated ? `This ${word} is on this statement twice`
          : row?.activity === t.transaction.bank ? `The bank entry for this ${word} may already be in ${account}`
          : `This ${word} may already be in ${account}`,
        line: "",
        main: "Skip this transaction",
        other: `Import it as a second ${word}`,
        receipt: (skip) => `${money ? `${money} ` : ""}${word} of ${fund} on ${when}: ${skip ? "skipped" : `imported as a second ${word}`}`,
        done: (skip) => (skip ? "skipped" : "imported"),
      },
      evidence,
      target: `${fund}, ${word}${money ? ` of ${money}` : ""} on ${when}`,
      answer: duplicateAnswers.get(key),
      set: (answer) => setDuplicateAnswers((all) => {
        const next = new Map(all);
        if (answer === undefined) next.delete(key);
        else next.set(key, answer);
        return next;
      }),
    };
  });
  const asks = [...unbalancedAsks, ...duplicateAsks];
  // Equal questions are told apart by number, as elsewhere.
  const targets0 = asks.map((a) => ({ name: a.target }));
  asks.forEach((a, i) => {
    a.target += nameNumber(targets0, i, a.id.startsWith("duplicate|") ? "transaction" : "fund");
  });
  const openAsks = asks.filter((a) => a.answer === undefined);
  // Fund lines, by box: what the counts say.
  const lines = boxes.flatMap((box) =>
    [...new Set(box.folios.flatMap((f) => f.schemes.map(fundKey)))].map((key) => ({ box, key })),
  );
  const lineState = ({ box, key }: { box: FundsBox; key: string }) => {
    const schemes = box.folios.flatMap((f) => f.schemes.filter((s) => fundKey(s) === key).map((scheme) => ({ folio: f, scheme })));
    const outcomes = (current?.mapping.outcomes ?? []).filter((o) => box.folios.includes(o.folio) && fundKey(o.scheme) === key);
    if (outcomes.some((o) => o.transaction && sentOf(planned.get(o.transaction)!))) return "ready";
    if ((questionKeys.includes(key) && schemes.some(({ folio }) => included(folio))) || schemes.some(({ folio }) => undecidedFolios.includes(folio)) ||
      schemes.some(({ folio, scheme }) => openAsks.some((a) => a.id === `unbalanced|${schemeKey(folio.folio, scheme.scheme)}`))) return "question";
    if (schemes.every(({ folio, scheme }) => target(folio, scheme) && !blockedSchemes.has(schemeKey(folio.folio, scheme.scheme))) && outcomes.every((o) => o.transaction && planned.get(o.transaction)?.status === "existing")) return "nothing";
    return "out";
  };
  const states = lines.map(lineState);
  const readyCount = states.filter((s) => s === "ready").length;
  const outCount = states.filter((s) => s === "out").length;

  const questionCount = openKeys.length + (accountQuestion ? 1 : 0) + openChecks.length + openAsks.length;
  const nothing = !accountQuestion && data.folios.every((f) => folioAccount(f) === LEFT_OUT);

  // Ids the focus moves to.
  const ids = {
    heading: id("heading"),
    another: id("another"),
    keep: id("keep-reviewing"),
    summary: id("summary"),
    ready: id("ready"),
    before: id("before"),
    questions: id("questions"),
    question: (key: string) => id(`q-${key}`),
    answerButton: (key: string) => id(`answer-${key}`),
    picker: (key: string) => id(`picker-${key}`),
    changePanel: (rowId: string) => id(`change-panel-${rowId}`),
    row: (row: FundRow, item = row.item) => ({ change: id(`change-${row.id}${item.key === row.item.key ? "" : `-${item.key}`}`) }),
    ask: (askId: string) => id(`ask-${sha256(askId)}`),
    askAnswer: (askId: string) => id(`ask-answer-${sha256(askId)}`),
    check: (checkId: string) => id(`check-${checkId}`),
    checkChange: (checkId: string) => id(`check-change-${checkId}`),
    showAll: id("show-all"),
    every: id("every"),
    notCreated: id("not-created"),
  };
  // The accounts the last import couldn't create, while something still goes to them.
  const missingNow = notCreated.filter((n) => data.folios.some((f) => accountOf(f) === n.accountId));

  /** The select a folio's account question is answered in. */
  const questionKey = (folio: CasFolio) => {
    if (folioState(folio) === "conflict") return bankChoiceOf(folio).key;
    if (!folioAccount(folio)) return valueOf(folioKey(folio)) === null || !folio.PAN ? folioKey(folio) : panKey(folio.PAN);
    return bankChoiceOf(folio).key;
  };
  /** Focuses the first account question, opening its box's folios when it's there. */
  const focusAccountQuestion = (force = false, origin?: Element | null) => {
    const folio = undecidedFolios[0];
    if (!folio) return;
    const key = questionKey(folio);
    const box = boxOf(folio);
    if (key !== box.key && key !== bankKey(box.key)) setOpen(`part:${box.key}`, true);
    focusSoon(key, force, origin);
  };
  const focusCheck = (check: BankCheckModel, force = false, origin?: Element | null) => {
    if (!boxKeys.has(check.anchor.replace(/^bank-/, ""))) {
      const folio = data.folios.find((f) => bankKey(folioKey(f)) === check.anchor);
      if (folio?.PAN) setOpen(`part:${boxOf(folio).key}`, true);
    }
    focusSoon(ids.check(check.id), force, origin);
  };
  const nextQuestion = (force = true) => {
    if (accountQuestion) return focusAccountQuestion(force);
    if (openChecks.length) return focusCheck(openChecks[0], force);
    if (openKeys.length) return focusSoon(ids.question(openKeys[0]), force);
    if (openAsks.length) return focusSoon(ids.ask(openAsks[0].id), force);
    focusSoon(ids.summary, force);
  };

  // As "Reading the statement…" ends: says what's still looked up, until the first searches are done.
  useEffect(() => {
    if (lookingUp.length) announce(`Looking up ${plural(lookingUp.length, "fund")}…`);
  }, []);
  // Says what the first searches found, once they're all done.
  const initial = useRef<readonly string[] | null>(questionKeys);
  useEffect(() => {
    const keys = initial.current;
    if (!keys || !current || lookingUp.length || keys.some((key) => !searched.current.has(key))) return;
    initial.current = null;
    const found = keys.filter((key) => matched[key]).length;
    const left = questionCount;
    announce(`${found ? `${plural(found, "fund")} found automatically on AMFI. ` : ""}${left ? `${plural(left, "question")} for you.` : "No questions for you."}`);
  });
  // Once AMFI is turned on, the open questions are searched again: says how many it matched.
  const amfiFocus = useRef<Element | null>(null);
  const amfiBatch = useRef<{ keys: string[]; origin: Element | null } | null>(null);
  const amfiSeen = useRef(amfi.searches);
  useEffect(() => {
    if (amfiSeen.current !== amfi.searches) {
      amfiSeen.current = amfi.searches;
      amfiBatch.current = openKeys.length ? { keys: openKeys, origin: amfiFocus.current } : null;
      amfiFocus.current = null;
      return;
    }
    const batch = amfiBatch.current;
    if (!batch) return;
    if (!current || lookingUp.length || batch.keys.some((key) => searches.get(key).auto?.status === "searching")) return;
    amfiBatch.current = null;
    const found = batch.keys.filter((key) => matched[key]).length;
    announce(`AMFI added: ${plural(found, "fund")} matched. ${questionCount ? `${plural(questionCount, "question")} ${questionCount === 1 ? "remains" : "remain"}.` : "No questions remain."}`);
    if (accountQuestion) focusAccountQuestion(false, batch.origin);
    else if (openChecks.length) focusCheck(openChecks[0], false, batch.origin);
    else focusSoon(openKeys.length ? ids.question(openKeys[0]) : openAsks.length ? ids.ask(openAsks[0].id) : ids.summary, false, batch.origin);
  });

  // After the last answer, the focus goes on to what's left, or to the summary.
  const afterAnswer = useRef(false);
  const afterChange = useRef<string | null>(null);
  const afterAsk = useRef(false);
  useEffect(() => {
    if (!current) return;
    if (afterAsk.current) {
      // A rare question answered: on to the next open question, once the plan is worked out again.
      afterAsk.current = false;
      if (lookingUp.length) focusSoon(ids.questions);
      else if (questionCount) nextQuestion(false);
      else {
        focusSoon(ids.summary);
        announce(`All questions answered.${counts?.toImport || counts?.importedDuplicates ? " Ready to import." : ""}`);
      }
    }
    const changed = afterChange.current;
    if (changed) {
      afterChange.current = null;
      const row = rows.find((r) => r.items.some((i) => i.key === changed));
      focusSoon(row ? ids.row(row, itemOf.get(changed)!).change : rows.length ? ids.ready : ids.summary);
    }
    if (!afterAnswer.current || questionKeys.length) return;
    afterAnswer.current = false;
    if (questionCount) nextQuestion(false);
    else {
      focusSoon(ids.summary);
      announce(`All questions answered.${counts?.toImport && !editor ? " Ready to import." : ""}`);
    }
  });

  const answerAsk = (ask: Ask, main: boolean) => {
    if (staleQuestions) return;
    ask.set(main);
    afterAsk.current = true;
  };
  const reopenAsk = (ask: Ask) => {
    ask.set(undefined);
    focusSoon(ids.ask(ask.id));
  };
  const answer = (key: string, choice: FundChoice) => {
    setAnswers((all) => ({ ...all, [key]: choice }));
    setHandled((all) => new Set(all).add(key));
    setTouched((all) => new Set(all).add(key));
    searches.settle(key);
    const rest = openKeys.filter((k) => k !== key);
    if (rest.length) focusSoon(ids.question(rest[0]));
    else afterAnswer.current = true;
  };
  const reopen = (key: string) => {
    if (busyEditor(`answer-${key}`)) return;
    setAnswers((all) => ({ ...all, [key]: undefined }));
    focusSoon(ids.question(key));
  };
  const answerCheck = (check: BankCheckModel, linked: boolean) => {
    const shown = new Map(check.pairs.map((p) => [p.entry.id, { entry: p.entry, facts: current!.facts.get(p.entry.id)! }]));
    setCheckAnswers((all) => ({ ...all, [check.id]: { linked, signature: check.signature, shown } }));
    const receipt = `${checkReceipt(check, linked ? check.pairs.filter((p) => tickedOf(check).has(p.key)).length : 0)}.`;
    const rest = openChecks.filter((c) => c.id !== check.id);
    if (accountQuestion) focusAccountQuestion();
    else if (rest.length) focusCheck(rest[0]);
    else if (openKeys.length) focusSoon(ids.question(openKeys[0]));
    else if (openAsks.length) focusSoon(ids.ask(openAsks[0].id));
    else if (lookingUp.length) {
      focusSoon(ids.questions);
      return announce(`${receipt} Looking up ${plural(lookingUp.length, "fund")}…`);
    }
    else {
      focusSoon(ids.summary);
      return announce(`${receipt} All questions answered.${counts?.toImport && !editor ? " Ready to import." : ""}`);
    }
    announce(receipt);
  };

  // One edit at a time: asking for another goes back to the open one.
  const busyEditor = (wanted: string) => {
    if (!editor || editor.rowId + editor.itemKey === wanted) return false;
    setNag(true);
    focusSoon(ids.changePanel(editor.rowId), false, document.activeElement);
    announce("Save or cancel this edit first.");
    return true;
  };
  const closeEditor = (focusId?: string) => {
    if (focusId && editor) setTouched((all) => new Set(all).add(editor.itemKey));
    setEditor(null);
    setNag(false);
    if (focusId) focusSoon(focusId, false, document.activeElement);
  };
  const openEditor = (rowId: string, item: FundItem, name: string, returnTo: string) => {
    if (busyEditor(rowId + item.key)) return;
    if (editor) return closeEditor(returnTo);
    setNag(false);
    setEditor({ rowId, itemKey: item.key, name });
    focusSoon(ids.changePanel(rowId), false, document.activeElement);
  };
  const change = (item: FundItem, choice: FundChoice) => {
    setAnswers((all) => ({ ...all, [item.key]: choice }));
    setHandled((all) => new Set(all).add(item.key));
    setTouched((all) => new Set(all).add(item.key));
    searches.settle(item.key);
    afterChange.current = item.key;
    closeEditor();
    announce(`${labelOf.get(item.key)}: ${answerWords(item, choice)}.`);
  };
  /** A fund's Change panel: its search in place, with Skip and Cancel. */
  const changePanel = (rowId: string, item: FundItem, returnTo: string) => (
    <div id={ids.changePanel(rowId)} data-focus-first="true" tabIndex={-1} className="grid gap-3 rounded-lg border p-4">
      <p className="text-muted-foreground text-sm">On your statement: {item.name}</p>
      {nag && <p className="text-warning text-sm">Save or cancel this edit first.</p>}
      <Picker
        item={item}
        label={labelOf.get(item.key)!}
        search={searches.get(item.key)}
        searches={searches}
        base={ids.picker(`change-${item.key}`)}
        onUse={(fund) => change(item, { fund })}
      >
        <Button type="button" variant="outline" aria-label={`Skip this fund: ${labelOf.get(item.key)}`} onClick={() => change(item, { leftOut: true })}>
          Skip this fund
        </Button>
        <Button type="button" variant="ghost" aria-label={`Cancel the change to ${labelOf.get(item.key)}`} onClick={() => closeEditor(returnTo)}>
          Cancel
        </Button>
      </Picker>
    </div>
  );
  const handlers: FundRowHandlers = {
    ids: ids.row,
    label: (row, item) => `${labelOf.get(item.key)!} in ${accountLabel(row.group.accountId)}`,
    changing: editor?.rowId,
    changingItem: editor?.itemKey,
    nag,
    onChange: (row, item = row.item) => openEditor(row.id, item, item.key === row.item.key ? row.name : item.name, ids.row(row, item).change),
    changePanel: (row) => {
      const item = itemOf.get(editor?.itemKey ?? row.item.key)!;
      return changePanel(row.id, item, ids.row(row, item).change);
    },
  };
  // Keep Change on its fund's shown line after the plan settles, or close it if none remains.
  useEffect(() => {
    if (!editor || !current) return;
    const shown = [
      ...rows.filter((r) => r.items.some((i) => i.key === editor.itemKey)).map((r) => r.id),
      ...(leftOutFunds.some((f) => f.key === editor.itemKey && f.canChange) ? [`left|${editor.itemKey}`] : []),
    ];
    if (shown.includes(editor.rowId)) return;
    if (shown[0]) setEditor({ ...editor, rowId: shown[0] });
    else closeEditor();
  });

  // Account choices: a change of where something goes clears what only it needed.
  const chooseAccount = (key: string, value: string) => {
    const after = (k: string) => (k === key ? value : valueOf(k));
    setPicks((all) => ({ ...all, [key]: value }));
    // A rename goes with its new account.
    if (renaming?.key === key && value !== proposedId(key)) setRenaming(null);
    // Answers and typed searches of funds no longer imported go.
    const dropped = items.filter((item) => foliosOf(item.key).every((f) => folioState(f, after) === "out")).map((i) => i.key);
    if (dropped.length) {
      setAnswers((all) => Object.fromEntries(Object.entries(all).filter(([k]) => !dropped.includes(k))));
      for (const k of dropped) searches.settle(k);
      if (editor && dropped.includes(editor.itemKey)) closeEditor();
    }
  };

  const searchChanges = items.filter((item) => {
    const s = searches.get(item.key);
    return !!s.text.trim() || !!s.typed || !!s.picked;
  }).length;
  const changes =
    Object.entries(picks).filter(([key, value]) => value !== (accountChoices[key] ?? (boxKeys.has(key) ? null : ""))).length +
    Object.keys(answers).length + duplicateAnswers.size + unbalancedAnswers.size + Object.keys(checkAnswers).length + Object.values(ticks).filter((t) => t.changed).length +
    searchChanges + (editor ? 1 : 0) + Object.keys(renamed).length + (renaming ? 1 : 0);

  const remember = () => {
    // A choice in place of an ignored one is remembered even when it's the same as having none.
    // A new account is remembered once it's created.
    const accountsChanged = Object.entries(picks).filter(([key, value]) => !isProposed(value) && (value !== (accountChoices[key] ?? "") || key in ignored));
    const funds = [
      ...Object.entries(matched).filter(([key]) => !(key in answers)).map(([key, fund]) => [key, { fund }] as [string, FundChoice]),
      ...Object.entries(answers).flatMap(([key, choice]) => (choice ? [[key, choice] as [string, FundChoice]] : [])),
    ];
    onRemember({ accounts: accountsChanged, funds });
  };

  // Rename edits a new account's name in place; its field and Rename button take the focus in turn.
  const renameIds = (key: string) => ({ rename: id(`rename-${key}`), field: id(`rename-field-${key}`) });
  const goToRename = (key: string) => {
    const box = boxKeys.has(key) ? undefined : boxes.find((b) => b.folios.some((f) => folioKey(f) === key));
    if (box) setOpen(`part:${box.key}`, true);
    focusSoon(renameIds(key).field, true);
  };
  const newLine = (key: string, label: string) => (
    <NewAccountLine
      proposed={proposed(key)}
      label={label}
      ids={renameIds(key)}
      editing={renaming?.key === key ? renaming : undefined}
      onRename={() => {
        if (renaming) {
          announce("Save or cancel the new account name first.");
          return goToRename(renaming.key);
        }
        setRenaming({ key, draft: proposed(key).name });
        focusSoon(renameIds(key).field, true);
      }}
      onDraft={(draft) => setRenaming((r) => r && { ...r, draft })}
      onSave={() => {
        if (!renaming) return;
        const problem = nameProblem(renaming.draft);
        if (problem) {
          setRenaming({ ...renaming, error: problem });
          announce(problem);
          focusSoon(renameIds(key).field, true);
          return;
        }
        const name = renaming.draft.trim();
        setRenamed((all) => ({ ...all, [key]: name }));
        setRenaming(null);
        announce(`The new account will be called ${name}.`);
        focusSoon(renameIds(key).rename, true);
      }}
      onCancel={() => {
        setRenaming(null);
        focusSoon(renameIds(key).rename, true);
      }}
    />
  );

  // A row or transaction with each new account this review created in place of its proposed ID.
  const inCreated = (row: ActivityImport): ActivityImport => {
    const account = row.accountId ? created.current.get(row.accountId) : undefined;
    return account ? { ...row, accountId: account.id } : row;
  };
  const transactionInCreated = (t: PlannedTransaction): PlannedTransaction => {
    const tr = t.transaction;
    return {
      ...t,
      transaction: {
        ...tr,
        activity: inCreated(tr.activity),
        cash: tr.cash && inCreated(tr.cash),
        bank: tr.bank && inCreated(tr.bank),
        arriving: tr.arriving && { ...tr.arriving, activity: inCreated(tr.arriving.activity) },
        receiving: tr.receiving && { ...tr.receiving, activity: inCreated(tr.receiving.activity) },
      },
      rows: t.rows.map((r) => ({ ...r, activity: inCreated(r.activity) })),
    };
  };

  // What the review chose when it imported, for Try again and Check again: the plan behind it can
  // change once accounts exist.
  const reviewedRef = useRef<{ target: typeof target; groups: typeof groups; fundsIn: typeof fundsIn; pointing: Map<string, string[]> } | null>(null);
  /** The accounts a part's rows go to, as the review names them. */
  const needs = (p: Part) => new Set(p.rows.flatMap((r) => (r.accountId ? [r.accountId] : [])));
  /** The fund accounts a part is counted in: its trade's, and the receiving side's of a gift between two. */
  const fundAccounts = (p: Part) =>
    [p.t.transaction.activity.accountId, p.t.transaction.receiving?.activity.accountId].flatMap((a) => (a ? [a] : []));
  /** The new accounts a part needs that Wealthfolio hasn't created. */
  const waitsFor = (p: Part) => [...needs(p)].filter((accountId) => isProposed(accountId) && !created.current.has(accountId));

  /** Creates the new accounts `ids` names that this review hasn't; returns those Wealthfolio didn't create. */
  const createAccounts = async (ids: string[], made: Account[], remembered: [string, string][]) => {
    const missing: NotCreated[] = [];
    for (const accountId of ids) {
      if (created.current.has(accountId)) continue;
      const name = accountName(accountId);
      try {
        const account = await api.accounts.create(newAccount(name, "TRANSACTIONS"));
        created.current.set(accountId, account);
        made.push(account);
        // The choices that pointed at it are remembered now that it exists.
        for (const key of reviewedRef.current?.pointing.get(accountId) ?? []) remembered.push([key, account.id]);
      } catch (e) {
        api.logger.error(`Couldn't create the account ${name}: ${String(e)}`);
        // Its name stays as shown while other new accounts take theirs.
        tried.current[proposalKey(accountId)] = name;
        missing.push({ accountId, name, error: String(e) });
      }
    }
    return missing;
  };

  /** Whether all of a part's rows went in, as Wealthfolio answered. */
  const landed = (p: Part, result: ImportActivitiesResult) => {
    if (!result.summary.success) return false;
    const back = new Map(result.activities.map((a) => [a.lineNumber, a]));
    return p.rows.every((r) => {
      const a = back.get(r.lineNumber);
      return !!a && !Object.keys(a.errors ?? {}).length && (!!r.forceImport || !(a.duplicateOfId || a.duplicateOfLineNumber));
    });
  };

  /**
   * Sends transactions: creates the new accounts they need (only `only`, for an account's Try again),
   * checks the rows for accounts created now, imports what's ready in one go, then uses the bank
   * entries chosen once their trades are in. A transaction that needs an account Wealthfolio didn't
   * create waits whole, with both sides of a gift and a trade's bank transfer; so does each one
   * Wealthfolio didn't import. One Wealthfolio refuses stays out, with its message.
   */
  const sendParts = async (parts: Part[], made: Account[], remembered: [string, string][], only?: string) => {
    const missing = await createAccounts([...new Set(parts.flatMap(waitsFor))].filter((a) => !only || a === only), made, remembered);
    const held = parts.filter((p) => waitsFor(p).length > 0);
    let ready = parts.filter((p) => !held.includes(p));
    const refused: ActivityImport[] = [];
    let result: ImportActivitiesResult = EMPTY;
    let sent: ActivityImport[] = [];
    let failed = false;
    try {
      // Rows for an account this review created are checked there before anything is imported.
      const fresh = ready.flatMap((p) => p.rows.filter((r) => isProposed(r.accountId)).map((row) => ({ p, row })));
      if (fresh.length) {
        const answers = await api.activities.checkImport(fresh.map((f) => inCreated(f.row)));
        const out = new Set<Part>();
        const rejected = new Map<ActivityImport, ActivityImport>();
        fresh.forEach(({ p, row }, i) => {
          const answer = answers[i];
          if (answer && answer.isValid !== false && !Object.keys(answer.errors ?? {}).length) return;
          out.add(p);
          rejected.set(row, {
            ...inCreated(row), isValid: false,
            errors: Object.keys(answer?.errors ?? {}).length ? answer!.errors : {
              general: [answer ? "Wealthfolio can't import this row." : "Wealthfolio didn't check this row."],
            },
          });
        });
        refused.push(...[...out].flatMap((p) => p.rows.map((row) => rejected.get(row) ?? {
          ...inCreated(row), isValid: false,
          errors: { general: ["Another row of this transaction was rejected, so none of it was imported."] },
        })));
        ready = ready.filter((p) => !out.has(p));
      }
      while (ready.length) {
        sent = ready.flatMap((p) => p.rows.map(inCreated));
        result = await api.activities.import(sent);
        if (result.summary.success) break;
        api.logger.error(`Wealthfolio didn't import the transactions: ${(result.summary as { errorMessage?: string }).errorMessage ?? "no reason given"}`);
        const errors = new Map(result.activities.filter((a) => Object.keys(a.errors ?? {}).length).map((a) => [a.lineNumber, a]));
        const out = ready.filter((p) => p.rows.some((r) => errors.has(r.lineNumber)));
        if (!out.length) {
          failed = true;
          break;
        }
        // Validation saved nothing: leave each refused transaction out whole, then send the rest.
        // Each failed attempt removes at least one transaction, so this always ends.
        for (const p of out) {
          refused.push(...p.rows.map((row) => errors.get(row.lineNumber) ?? {
            ...inCreated(row), isValid: false,
            errors: { general: ["Another row of this transaction was rejected, so none of it was imported."] },
          }));
        }
        ready = ready.filter((p) => !out.includes(p));
        sent = [];
        result = EMPTY;
      }
    } catch (e) {
      api.logger.error(`Wealthfolio didn't import the transactions: ${String(e)}`);
      failed = true;
    }
    if (failed) {
      // Nothing went in: what wasn't refused waits for Try again, as it was.
      const out = new Set(refused.map((r) => r.lineNumber));
      held.push(...parts.filter((p) => !held.includes(p) && !p.rows.some((r) => out.has(r.lineNumber))));
      ready = [];
      sent = [];
      result = EMPTY;
    }
    if (refused.length) {
      // Reported as rows Wealthfolio rejected.
      const summary = result.summary;
      result = {
        ...result,
        activities: [...result.activities, ...refused],
        summary: { ...summary, total: (summary.total ?? 0) + refused.length, skipped: (summary.skipped ?? 0) + refused.length },
      };
    }
    const done = ready.filter((p) => landed(p, result));
    // Each bank entry used, once its transaction's trade is in.
    const links: BankLink[] = [];
    for (const p of ready.filter((p) => p.entry)) {
      const line = p.t.transaction.activity.lineNumber;
      const trade = result.activities.find((a) => a.lineNumber === line);
      const wasForced = sent.some((r) => r.lineNumber === line && r.forceImport);
      const ok = trade && !Object.keys(trade.errors ?? {}).length && (wasForced || !(trade.duplicateOfId || trade.duplicateOfLineNumber));
      links.push({
        transaction: p.t,
        bankRow: p.entry!.row,
        facts: p.entry!.facts,
        ...(ok
          ? await reuseBankEntry(api, transactionInCreated(p.t), p.entry!.row, p.entry!.facts)
          : { error: "The trade wasn't imported, so the bank's entry was left as it is.", stage: "trade" as const, changes: [], warnings: [] }),
      });
    }
    for (const link of links) if (link.error) api.logger.error(link.error);
    if (sent.length || links.length) {
      api.query.invalidateQueries([QueryKeys.ACTIVITY_DATA]);
      api.query.invalidateQueries([QueryKeys.ACTIVITIES]);
    }
    return { missing, held, done, result, sent, links, failed };
  };

  /**
   * Each fund's units, read back from Wealthfolio, in the accounts that got all their transactions:
   * a fund whose account wasn't created, or whose transactions wait, isn't checked.
   */
  const checkClosing = async (state: Imported): Promise<FundUnits[]> => {
    const reviewed = reviewedRef.current!;
    const blocked = new Set(state.parts.filter((p) => !state.done.has(p)).flatMap((p) => [...fundAccounts(p), ...waitsFor(p)]));
    const saved = new Set([...state.done].flatMap(fundAccounts));
    const inAccount = (f: CasFolio, s: CasScheme) => {
      const t = reviewed.target(f, s);
      if (!t || (isProposed(t.accountId) && !created.current.has(t.accountId))) return undefined;
      return { ...t, accountId: created.current.get(t.accountId)?.id ?? t.accountId };
    };
    // Only funds this import sent transactions for: one whose rows all wait isn't checked.
    const touched = new Set(reviewed.groups.filter((g) => g.sent > 0 && saved.has(g.accountId) && !blocked.has(g.accountId))
      .flatMap((g) => g.schemes.map((s) => s.scheme)));
    const accountIds = [...new Set(data.folios.flatMap((f) => f.schemes.flatMap((s) => {
      const t = touched.has(s) ? inAccount(f, s) : undefined;
      return t ? [t.accountId, ...(t.bankAccountId ? [t.bankAccountId] : [])] : [];
    })))];
    if (!accountIds.length) return [];
    const after = (await Promise.all(accountIds.map((accountId) => api.activities.getAll(accountId)))).flat();
    const targetOf = (f: CasFolio, s: CasScheme) => (touched.has(s) ? inAccount(f, s) : undefined);
    const funds = await reviewed.fundsIn(after, (assetId) => api.assets.getProfile(assetId), targetOf);
    return closingUnits(data, targetOf, after, funds, await engineTimeZone(api.settings));
  };

  /** Runs the units check for what's imported; one that fails says so, with Check again. */
  const runCheck = async (state: Imported) => {
    let closing: ClosingCheck;
    try {
      closing = await checkClosing(state);
    } catch (e) {
      api.logger.error(`Couldn't check the units in Wealthfolio: ${String(e)}`);
      closing = "failed";
    }
    setImported({ ...(latestImported.current ?? state), closing });
    return closing;
  };

  /**
   * Imports the transactions the review approved: each new account first, then what's ready in one
   * go. A transaction that needs an account Wealthfolio didn't create waits, and so does each one it
   * didn't import, and each account's Try again goes on from what waits for it, with the review as it
   * was. Try again never creates an account twice, nor imports a transaction or adds a transfer again.
   * When nothing went in, the review stays as it was, with Try again.
   */
  const runImport = async () => {
    // Only what was reviewed and answered is imported.
    if (!current || !canImport) return;
    remember();
    // Firefox keeps the focus on the pressed button while it's disabled; the others drop it.
    const pressed = document.activeElement;
    setBusy("import");
    setError("");
    setNotCreated([]);
    const made: Account[] = [];
    const nowRemembered: [string, string][] = [];
    // The review stays as it was, its alert saying why, and the focus goes there.
    const stay = () => focusSoon(ids.notCreated, false, pressed);
    try {
      // Re-read what the user accepted, even when revisiting refreshed the plan behind the receipt.
      const approved = new Map(checks.flatMap((c) => answerOf(c)?.linked ? [...answerOf(c)!.shown] : []));
      const chosen = sentPlan.filter(reused).map((t): [PlannedTransaction, ActivityDetails] => [t, approved.get(matches.get(t)!.id)!.entry]);
      const shownFacts = new Map([...approved].map(([entryId, shown]) => [entryId, shown.facts]));
      let checked: Awaited<ReturnType<typeof recheckEntries>>;
      try {
        checked = await recheckEntries(api, chosen, shownFacts, accountName);
      } catch (e) {
        api.logger.error(`Couldn't read the bank entries chosen again: ${String(e)}`);
        setError(RECHECK_FAILED);
        return stay();
      }
      if (checked.stale.length) {
        setStale(checked.stale);
        const latest = checked;
        const disclosed = new Set(latest.stale.map((s) => s.before.id));
        setCheckAnswers((all) => {
          let next = all;
          for (const check of checks) {
            const answer = next[check.id];
            if (!answer?.linked || answer.signature !== check.signature) continue;
            const shown = new Map(answer.shown);
            for (const pair of check.pairs) {
              const entry = latest.current.get(pair.t);
              if (entry && disclosed.has(entry.id)) shown.set(entry.id, { entry, facts: latest.facts.get(entry.id)! });
            }
            next = { ...next, [check.id]: { ...answer, shown } };
          }
          return next;
        });
        cache.current = { reads: new Map() };
        setGeneration((n) => n + 1);
        return;
      }
      setStale(null);
      const parts = plan.flatMap((t): Part[] => {
        const rows = importRows([t], forced, reused);
        if (!rows.length) return [];
        const row = reused(t) ? checked.current.get(t) : undefined;
        return [{ t, rows, entry: row && { row, facts: checked.facts.get(row.id)! } }];
      });
      const pointing = new Map<string, string[]>();
      for (const key of [...boxes.map((b) => b.key), ...data.folios.map(folioKey)]) {
        const value = valueOf(key);
        if (isProposed(value)) pointing.set(value, [...(pointing.get(value) ?? []), key]);
      }
      reviewedRef.current = { target, groups, fundsIn, pointing };

      const run = await sendParts(parts, made, nowRemembered);
      if (!run.done.length && !run.result.activities.length) {
        // Nothing went in: the review stays as it was, saying why.
        setNotCreated(run.missing);
        if (run.failed) setError(IMPORT_FAILED);
        return stay();
      }
      const state: Imported = { result: run.result, sent: run.sent, parts, done: new Set(run.done), held: run.held, links: run.links, closing: undefined };
      setImported(state);
      await runCheck(state);
      const imported = run.done.length;
      const summary = imported === parts.length
        ? `${plural(imported, "transaction")} imported.`
        : `${imported} of ${plural(parts.length, "transaction")} imported.`;
      announce([
        summary,
        ...outcomesOf(state).filter((a) => a.state !== "imported").map((a) => `${outcomeWords(a)}${a.retryable ? ` Try again for ${a.name}.` : ""}`),
        ...run.links.filter((l) => l.stage).map((l) => `${linkWords(l)}${l.stage === "trade" ? "" : " Try again to link the bank entry."}`),
        ...(latestImported.current?.closing === "failed" ? ["Saved, but the units couldn't be checked in Wealthfolio. Check again."] : []),
      ].join(" "));
    } catch (e) {
      api.logger.error(`The import stopped: ${String(e)}`);
      setError(IMPORT_FAILED);
      if (!latestImported.current) stay();
    } finally {
      settleCreated(made, nowRemembered);
      setBusy("");
    }
  };

  /** Try again beside an account: creates it if it wasn't, then imports what waits for it. */
  const retryAccount = async (key: string) => {
    const state = latestImported.current;
    if (!state) return;
    const uncreated = isProposed(key) && !created.current.has(key);
    const parts = state.held.filter((p) => (uncreated ? needs(p).has(key) : fundAccounts(p).includes(key) && !waitsFor(p).length));
    const pressed = document.activeElement;
    setBusy("import");
    setError("");
    const made: Account[] = [];
    const remembered: [string, string][] = [];
    try {
      // The bank entries chosen are read again, as before the first import.
      const linking = parts.filter((p) => p.entry).map((p): [PlannedTransaction, ActivityDetails] => [p.t, p.entry!.row]);
      if (linking.length) {
        let latest: Awaited<ReturnType<typeof recheckEntries>>;
        try {
          latest = await recheckEntries(api, linking, new Map(parts.flatMap((p) => (p.entry ? [[p.entry.row.id, p.entry.facts] as const] : []))), accountName);
        } catch (e) {
          api.logger.error(`Couldn't read the bank entries chosen again: ${String(e)}`);
          setError("We couldn't check the bank entries you chose again, so nothing more was imported. Try again.");
          return;
        }
        if (latest.stale.length) {
          setError("A bank entry you chose changed since the import, so nothing more was imported. Read the statement again to review it.");
          return;
        }
      }
      const run = await sendParts(parts, made, remembered, key);
      const next: Imported = {
        ...state,
        result: mergeResults(state.result, run.result),
        sent: [...state.sent, ...run.sent],
        done: new Set([...state.done, ...run.done]),
        held: [...state.held.filter((p) => !parts.includes(p)), ...run.held],
        links: [...state.links, ...run.links],
      };
      setImported(next);
      if (run.done.length) await runCheck(next);
      const outcome = outcomesOf(latestImported.current ?? next).find((a) => a.key === key);
      announce([
        outcome ? `${outcomeWords(outcome)}${outcome.state === "imported" ? "." : ""}` : "",
        ...run.links.filter((l) => l.stage).map((l) => `${linkWords(l)}${l.stage === "trade" ? "" : " Try again to link the bank entry."}`),
        ...(run.done.length && latestImported.current?.closing === "failed" ? ["Saved, but the units couldn't be checked in Wealthfolio. Check again."] : []),
      ].join(" "));
    } catch (e) {
      api.logger.error(`The import stopped: ${String(e)}`);
      setError("Nothing more was imported. Try again.");
    } finally {
      settleCreated(made, remembered);
      setBusy("");
      focusSoon(importIds(id("result")).account(key), false, pressed);
    }
  };

  /** Try again beside a bank entry that wasn't linked: goes on from the step that failed. */
  const retryLink = async (link: BankLink) => {
    const state = latestImported.current;
    if (!state) return;
    const pressed = document.activeElement;
    setBusy("import");
    let next = link;
    try {
      setError("");
      const t = transactionInCreated(link.transaction);
      const from = { fundId: link.fundId, converted: link.converted };
      const checked = await recheckLink(api, t, link.bankRow, link.facts, from);
      const again = await reuseBankEntry(api, t, checked.row, checked.facts, { ...from, linked: checked.linked });
      if (again.error) api.logger.error(again.error);
      next = { ...link, ...again, changes: [...new Set([...link.changes, ...again.changes])], warnings: again.warnings };
      setImported({ ...(latestImported.current ?? state), links: (latestImported.current ?? state).links.map((l) => (l === link ? next : l)) });
      api.query.invalidateQueries([QueryKeys.ACTIVITY_DATA]);
      api.query.invalidateQueries([QueryKeys.ACTIVITIES]);
      announce(next.stage ? `Still not done. ${linkWords(next)}` : `The bank entry of ${longDate(day(link.bankRow.date))} is linked.`);
    } catch (e) {
      api.logger.error(`Couldn't resume the bank link: ${String(e)}`);
      setError(explanation(e) || "We couldn't check the bank entries again. Nothing more was changed. Try again.");
    } finally {
      setBusy("");
      const result = importIds(id("result"));
      focusSoon(next.stage ? result.link(next) : result.linked, false, pressed);
    }
  };

  /** Check again: the units check, run again. */
  const checkAgain = async () => {
    const state = latestImported.current;
    if (!state) return;
    const pressed = document.activeElement;
    setBusy("check");
    try {
      const closing = await runCheck(state);
      announce(closing === "failed"
        ? "The units still couldn't be checked in Wealthfolio."
        : closing?.some((f) => !sameUnits(f))
          ? `Checked in Wealthfolio: units differ for ${closing.filter((f) => !sameUnits(f)).length} of ${plural(closing.length, "fund")}.`
          : "Checked in Wealthfolio: units match the statement.");
    } finally {
      setBusy("");
      focusSoon(importIds(id("result")).units, false, pressed);
    }
  };

  /** Each account the import went to, and what it did there. */
  const outcomesOf = (state: Imported): ImportOutcome[] => {
    const keys: string[] = [];
    for (const p of state.parts) {
      for (const key of [...fundAccounts(p), ...waitsFor(p)]) if (!keys.includes(key)) keys.push(key);
    }
    return keys.map((key) => {
      const imported = [...state.done].filter((p) => fundAccounts(p).includes(key)).length;
      const uncreated = isProposed(key) && !created.current.has(key);
      const unfinished = state.parts.filter((p) => !state.done.has(p) && (uncreated ? needs(p).has(key) : fundAccounts(p).includes(key)));
      const waiting = unfinished.length;
      const retryable = state.held.some((p) => (uncreated ? needs(p).has(key) : fundAccounts(p).includes(key) && !waitsFor(p).length));
      const waitingFor = [...new Set(unfinished.flatMap(waitsFor).filter((a) => a !== key))].map(accountName).join(" and ");
      const proposal = isProposed(key) ? proposalKey(key) : "";
      const box = boxes.find((b) => b.key === proposal);
      const folio = data.folios.find((f) => folioKey(f) === proposal);
      return {
        key,
        accountId: created.current.get(key)?.id ?? (isProposed(key) ? undefined : key),
        name: accountName(key),
        isNew: isProposed(key),
        who: uncreated ? (box ? `${box.name}'s` : folio ? `${folioName(folio)}'s` : undefined) : undefined,
        imported,
        waiting,
        retryable,
        waitingFor,
        state: uncreated && waiting ? "not-created" : waiting ? "failed" : "imported",
      };
    });
  };

  /**
   * Accounts an import created join the page's, and the choices that pointed at them are remembered
   * and now name them, so a review that stays goes on with them as existing accounts.
   */
  const settleCreated = (made: Account[], remembered: [string, string][]) => {
    if (made.length) onCreated(made);
    if (!remembered.length) return;
    onRemember({ accounts: remembered, funds: [] });
    setPicks((all) => ({ ...all, ...Object.fromEntries(remembered) }));
  };

  const registrar = REGISTRARS[statement.file_type] ?? statement.file_type;
  const from = statementDay(statement.statement_period.from);
  const to = statementDay(statement.statement_period.to);
  const who = list([...new Set(boxes.map((b) => b.name))]) || statement.investor_info.name?.trim() || "This investor";
  const header = (
    <ReviewHeader
      ids={{ heading: ids.heading, another: ids.another, keep: ids.keep, discard: id("discard") }}
      title={`Transactions, ${longDate(from)} to ${longDate(to)}`}
      lines={[`${registrar} statement · ${who} · ${fileName}`]}
      changes={imported ? 0 : changes}
      unfinished={!!imported && (imported.done.size !== imported.parts.length || imported.links.some((l) => l.stage) || imported.closing === "failed")}
      discard={discard}
      onAnother={() => onAnother()}
      onDiscard={() => {
        setDiscard(true);
        focusSoon(ids.keep, false, document.activeElement);
      }}
      onKeep={() => {
        setDiscard(false);
        focusSoon(ids.another, false, document.activeElement);
      }}
    />
  );
  const status = (
    <p id={id("status")} role="status" className="sr-only">
      {busy === "import" ? "Saving…" : busy === "check" ? "Checking the units…" : said}
    </p>
  );

  if (imported) {
    return (
      <div className="grid gap-6">
        {header}
        {status}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>{error}</AlertTitle>
          </Alert>
        )}
        <ImportResult
          result={imported.result}
          sent={imported.sent}
          total={imported.parts.length}
          imported={imported.done.size}
          outcomes={outcomesOf(imported)}
          closing={imported.closing}
          links={imported.links}
          accounts={[...allAccounts, ...created.current.values()]}
          base={id("result")}
          onRetryAccount={(key) => void retryAccount(key)}
          onRetryLink={(link) => void retryLink(link)}
          onCheckAgain={() => void checkAgain()}
          onOpenAccount={(accountId) =>
            api.navigation.navigate(`/accounts/${accountId}`).catch(() => api.toast.error("Couldn't open the account."))}
        />
      </div>
    );
  }

  const amfiFunds = openKeys.filter((key) => {
    const item = itemOf.get(key)!;
    const auto = searches.get(key).auto;
    return item.isin && auto?.status === "done" && !auto.amfi;
  }).length;
  const answeredKeys = items.filter((item) => item.key in answers && answers[item.key] && foliosOf(item.key).some(included)).map((i) => i.key);
  const anyQuestions = questionKeys.length > 0 || answeredKeys.length > 0 || asks.length > 0;
  const openCount = openKeys.length + openAsks.length;
  const answeredCount = answeredKeys.length + asks.length - openAsks.length;
  /** A rare question's card while it's open, then its answered line. */
  const askView = (ask: Ask, level: 4 | 5 = 4) => {
    if (ask.answer !== undefined) {
      return (
        <ul key={ask.id} className="grid">
          <AskAnswered text={ask.words.receipt(ask.answer)} target={ask.target} warn={ask.warn} buttonId={ids.askAnswer(ask.id)} onChange={() => reopenAsk(ask)} />
        </ul>
      );
    }
    return (
      <AskCard
        key={ask.id}
        headingId={ids.ask(ask.id)}
        title={ask.words.title}
        target={ask.target}
        level={level}
        main={{ label: ask.words.main, name: `${ask.words.main}: ${ask.target}`, onClick: () => answerAsk(ask, true) }}
        other={{ label: ask.words.other, name: `${ask.words.other}: ${ask.target}`, onClick: () => answerAsk(ask, false) }}
        disabled={busy !== "" || staleQuestions}
      >
        {ask.evidence ?? <p>{ask.words.line}</p>}
      </AskCard>
    );
  };
  // More than three possible duplicates go under one heading, a card each.
  const duplicateViews = duplicateAsks.length > 3 ? (
    <section aria-labelledby={id("duplicates")} className="grid grid-cols-1 gap-3">
      <h4 id={id("duplicates")} className="font-semibold" style={{ overflowWrap: "anywhere" }}>
        {duplicateAsks.length} transactions may already be in {duplicateAccounts.size === 1 ? [...duplicateAccounts][0] : "Wealthfolio"}
      </h4>
      {duplicateAsks.map((ask) => askView(ask, 5))}
    </section>
  ) : (
    duplicateAsks.map((ask) => askView(ask))
  );
  const values = Object.fromEntries(
    [...boxes.map((b) => b.key), ...boxes.map((b) => bankKey(b.key)), ...data.folios.flatMap((f) => [folioKey(f), bankKey(folioKey(f))])].map((key) => [key, valueOf(key)]),
  );
  const rememberedBoxes = boxes.filter((b) => !!usable[b.key] && !(b.key in picks)).length;
  // A folio's own bank choice, or one of its checks, keeps its box's folios open.
  const partOpen = Object.fromEntries(boxes.map((box) => [
    box.key,
    !!open[`part:${box.key}`] || openChecks.some((c) => box.folios.some((f) => bankKey(folioKey(f)) === c.anchor)),
  ]));
  const checkFor = (anchor: string) =>
    checks.filter((c) => c.anchor === anchor).map((check) => {
      const answer = answerOf(check);
      const ticked = tickedOf(check);
      return (
        <div key={check.id} className="mt-2">
          <BankCheck
            check={check}
            ticked={ticked}
            answered={answer ? (answer.linked ? ticked.size : 0) : undefined}
            facts={current!.facts}
            fundName={(pair) => {
              const scheme = schemeOf(pair.t);
              return scheme ? fundNameOf(fundKey(scheme)) : pair.t.transaction.scheme;
            }}
            headingId={ids.check(check.id)}
            changeId={ids.checkChange(check.id)}
            pairId={(pair) => id(`pair-${pair.key}`)}
            onTick={(key, yes) =>
              setTicks((all) => {
                const keys = new Set(tickedOf(check));
                if (yes) keys.add(key);
                else keys.delete(key);
                return { ...all, [check.id]: { signature: check.signature, keys: [...keys], changed: true } };
              })
            }
            onLink={() => answerCheck(check, true)}
            onNone={() => answerCheck(check, false)}
            onChange={() => {
              setCheckAnswers((all) => {
                const { [check.id]: _, ...rest } = all;
                return rest;
              });
              focusSoon(ids.check(check.id));
            }}
          />
        </div>
      );
    });
  const editWhat = editor ? `your change to ${editor.name}` : "";
  const differ = rows.filter((r) => r.note);
  const perAccount = [...new Set(rows.map((r) => r.group.accountId))].map((accountId) => {
    const inAccount = rows.filter((r) => r.group.accountId === accountId);
    return { accountId, transactions: inAccount.reduce((n, r) => n + r.group.sent, 0), funds: inAccount.length };
  });
  // The bank movements of what's sent, by box and bank account.
  const bankLines = boxes.flatMap((box) => {
    const ofBox = sentPlan.filter((t) => t.transaction.bank && box.folios.includes(folioOfTransaction.get(t.transaction)!));
    return [...new Set(ofBox.map((t) => t.transaction.bank!.accountId))].map((bankId) => {
      const moving = ofBox.filter((t) => t.transaction.bank!.accountId === bankId);
      const { linked, created } = bankMovements(moving, reused);
      const purchases = moving.some((t) => paid({ t }));
      const payouts = moving.some((t) => !paid({ t }));
      const bank = accountName(bankId);
      const flows = purchases && payouts
        ? `${box.name}'s purchases transfer from ${bank}, and sales and payouts back to it`
        : purchases
          ? `${box.name}'s purchases transfer from ${bank}`
          : `${box.name}'s sales and payouts transfer to ${bank}`;
      const counted = !linked
        ? `${created === 1 ? "it gets a new transfer" : `${created} get new transfers`}`
        : !created
          ? `${linked === 1 ? "it uses an entry" : `all ${linked} use entries`} already there`
          : `${linked} ${linked === 1 ? "uses an entry" : "use entries"} already there, ${created} ${created === 1 ? "gets a new transfer" : "get new transfers"}`;
      return `${flows}: ${counted}.`;
    });
  });
  const leftWords = (() => {
    const bank = openChecks.length;
    const others = questionCount - bank;
    const fundOnly = !accountQuestion && !openAsks.length;
    const checkWords = bank === 1 ? "the payment check" : `${bank} payment checks`;
    if (bank && others) return `${plural(questionCount, "question")} left: ${checkWords} and ${plural(others, fundOnly ? "fund question" : "other question")} before importing.`;
    if (bank) return `${plural(questionCount, "question")} left: ${checkWords} before importing.`;
    return `${plural(questionCount, "question")} left before importing.`;
  })();
  const toImport = (counts?.toImport ?? 0) + (counts?.importedDuplicates ?? 0);
  // The new accounts the import creates first.
  const creating = perAccount.filter((a) => isProposed(a.accountId)).length;
  // Whether the review can be imported as it stands: the import button's checks, which Try again shares.
  const canImport = !questionCount && !lookingUp.length && !nothing && !!current && !!counts && toImport > 0 && !editor && !renaming &&
    busy === "" && !prepareError;
  const importLabel = creating
    ? `Create ${creating === 1 ? "account" : `${creating} accounts`} and import ${plural(toImport, "transaction")}`
    : `Import ${plural(toImport, "transaction")}`;
  // What the answers to the rare questions do.
  const answerParts = [
    ...(() => {
      const skipped = duplicateAsks.filter((a) => a.answer === true).length;
      const imported = duplicateAsks.filter((a) => a.answer === false).length;
      return [
        imported && `${plural(imported, "possible duplicate")} imported by your answer`,
        skipped && `${plural(skipped, "possible duplicate")} skipped by your answer`,
      ];
    })(),
    ...unbalancedAsks.filter((a) => a.answer !== undefined).map((a) => a.words.done(a.answer!)),
  ].filter((part): part is string => !!part);
  const answerLine = answerParts.length
    ? [
        <p key="answers" className="text-muted-foreground">
          {capital(answerParts.join("; "))}.
        </p>,
      ]
    : [];
  const range = `${month(from)} to ${month(to)}`;

  return (
    <div className="space-y-6">
      {header}
      {status}
      <SearchDown down={searches.down} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{plural(lines.length, "fund")}</Badge>
        {lookingUp.length > 0 ? (
          <Badge variant="outline">
            <Spinner /> Looking up {lookingUp.length}…
          </Badge>
        ) : (
          <>
            {current && <Badge variant="outline">{readyCount} ready</Badge>}
            {current && outCount > 0 && <Badge variant="outline">{outCount} not included</Badge>}
            {questionCount > 0 && (
              <Button type="button" variant="outline" size="xs" className="border-warning" onClick={() => nextQuestion()}>
                {plural(questionCount, "question")}
              </Button>
            )}
          </>
        )}
      </div>
      {statement.parse_warnings.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>casparser reported warnings</AlertTitle>
          <AlertDescription>
            A row or a whole scheme may have been dropped or misread. Each fund whose rows don't add up to its closing balance is asked about
            under “Questions for you”; check anything else these name against the PDF before importing.
            <ul className="list-disc ps-4">
              {statement.parse_warnings.map((warning) => (
                <li key={warning}>{readableName(warning)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <SaveToDetailed
        boxes={boxes}
        targets={targets}
        proposed={(key) => created.current.has(proposedId(key)) ? undefined : proposed(key)}
        newLine={newLine}
        values={values}
        ignored={Object.fromEntries(Object.entries(ignored).filter(([key]) => !(key in picks)))}
        conflicts={conflicts}
        remembered={rememberedBoxes === boxes.length ? "all" : rememberedBoxes ? "some" : "none"}
        open={Object.fromEntries(boxes.map((b) => [b.key, partOpen[b.key]]))}
        onOpen={(key, yes) => setOpen(`part:${key}`, yes)}
        onChange={chooseAccount}
        checks={checkFor}
        partId={id("save-to")}
      />
      {/* A fund's asset that changed or went in Wealthfolio: each fund's Change is at hand. The status
          region already said it. */}
      {prepareError?.why && (
        <Alert variant="destructive" role="group" aria-label={CANT_PLAN}>
          <AlertTitle>{CANT_PLAN}</AlertTitle>
          <AlertDescription>
            <p>{prepareError.why}</p>
            <ul className="grid gap-2">
              {items.filter((item) => fundOf(item.key)).map((item) => (
                <li key={item.key}>
                  {labelOf.get(item.key)} · <LinkButton type="button" aria-label={`Change: ${labelOf.get(item.key)}`} onClick={() => reopen(item.key)}>Change</LinkButton>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {anyQuestions && (
        <section aria-labelledby={ids.questions} className="grid gap-3">
          <h3 id={ids.questions} tabIndex={-1} className="text-muted-foreground text-sm font-semibold uppercase tracking-wide">
            {openChecks.length > 0 && openCount > 0 ? (accountQuestion || openAsks.length ? "Other questions" : "Fund questions") : "Questions for you"}
            {openCount > 0 && ` · ${openCount} of ${openCount + answeredCount} left`}
          </h3>
          {amfiFunds > 0 && amfi.status !== "on" && (
            <Alert variant="warning">
              <AlertDescription>
                <p>
                  {amfi.status === "off" ? "AMFI isn't added" : "AMFI may not be added"}, so {amfiFunds === 1 ? "1 fund was" : `${amfiFunds} funds were`} only
                  searched on Yahoo Finance and {amfiFunds === 1 ? "needs" : "need"} you. Add AMFI to match {amfiFunds === 1 ? "it" : "them"} for you.
                </p>
                {amfi.outcome && <p className="text-warning">{amfi.outcome}</p>}
                <div className="flex flex-wrap gap-2">
                  <WrapButton
                    type="button"
                    variant={amfi.settingsOpened ? "outline" : "default"}
                    onClick={amfi.openSettings}
                  >
                    Open Market data settings
                  </WrapButton>
                  {amfi.settingsOpened && (
                    <WrapButton
                      type="button"
                      onClick={() => {
                        amfiFocus.current = document.activeElement;
                        void amfi.check();
                      }}
                    >
                      {amfi.checking && <Spinner />}
                      I've added AMFI: check
                    </WrapButton>
                  )}
                </div>
              </AlertDescription>
            </Alert>
          )}
          {lookingUp.length > 0 && (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Spinner /> Looking up {plural(lookingUp.length, "fund")}…
            </p>
          )}
          {openCount === 0 && answeredCount > 0 && lookingUp.length === 0 ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-2 rounded-lg border p-3">
              <span aria-hidden="true" className="text-success">
                ✓
              </span>
              <span>{answeredCount === 1 ? "Question answered." : `All ${answeredCount} questions answered.`}</span>
              <Disclosure
                id={id("show-answers")}
                label={open.answers ? "Hide answers" : "Show answers"}
                open={!!open.answers}
                onOpenChange={(yes) => setOpen("answers", yes)}
              >
                <ul className="mt-2 grid gap-2">
                  {answeredKeys.map((key) => (
                    <AnsweredLine
                      key={key}
                      item={itemOf.get(key)!}
                      label={labelOf.get(key)!}
                      choice={answers[key]!}
                      buttonId={ids.answerButton(key)}
                      onChange={() => reopen(key)}
                    />
                  ))}
                  {asks.map((ask) => (
                    <AskAnswered key={ask.id} text={ask.words.receipt(ask.answer!)} target={ask.target} warn={ask.warn} buttonId={ids.askAnswer(ask.id)} onChange={() => reopenAsk(ask)} />
                  ))}
                </ul>
              </Disclosure>
            </div>
          ) : (
            <div className="grid gap-3">
              {items
                .filter((item) => openKeys.includes(item.key) || answeredKeys.includes(item.key))
                .map((item) =>
                  openKeys.includes(item.key) ? (
                    <QuestionCard
                      key={item.key}
                      item={item}
                      label={labelOf.get(item.key)!}
                      skip="fund"
                      units={`${units(format(foliosOf(item.key).filter(included).flatMap((f) => f.schemes.filter((s) => fundKey(s) === item.key))
                        .reduce((total, s) => add(total, dec(s.close)), dec("0"))))} units`}
                      search={searches.get(item.key)}
                      searches={searches}
                      base={ids.picker(item.key)}
                      amfiOn={amfi.status === "on"}
                      headingId={ids.question(item.key)}
                      onAnswer={(choice) => answer(item.key, choice)}
                    />
                  ) : (
                    <ul key={item.key} className="grid">
                      <AnsweredLine
                        item={item}
                        label={labelOf.get(item.key)!}
                        choice={answers[item.key]!}
                        buttonId={ids.answerButton(item.key)}
                        onChange={() => reopen(item.key)}
                      />
                    </ul>
                  ),
                )}
              {unbalancedAsks.map((ask) => askView(ask))}
              {duplicateViews}
            </div>
          )}
        </section>
      )}
      {(rows.length > 0 || nothingNewKeys.length > 0) && (
        <section aria-labelledby={ids.ready} className="grid gap-3">
          <h3 id={ids.ready} tabIndex={-1} className="text-muted-foreground text-sm font-semibold uppercase tracking-wide">
            Ready to import ({rows.length})
          </h3>
          {autoCount > 0 && (
            <p className="text-muted-foreground text-sm">{plural(autoCount, "fund")} found automatically on AMFI. Change any that look wrong.</p>
          )}
          {rows.length > 0 && (
            <FundsReadyTable
              ctx={ctx}
              rows={rows}
              wide={wide}
              showAll={showAll}
              onShowAll={() => {
                setShowAll(true);
                focusSoon(ids.ready, false, document.activeElement);
              }}
              showAllId={ids.showAll}
              handlers={handlers}
            />
          )}
          {nothingNewKeys.map((key) => (
            <p key={key} className="text-muted-foreground text-sm">
              Nothing new for {fundNameOf(key)}. <LinkButton type="button" aria-label={`Change: ${labelOf.get(key)}, nothing new`} onClick={() => reopen(key)}>Change</LinkButton>
            </p>
          ))}
        </section>
      )}
      <NotIncludedDetailed
        earlier={earlier}
        skipped={skipped.map((item) => labelOf.get(item.key)!)}
        unbalanced={[...new Set(unbalancedAsks.filter((a) => a.answer === true).map((a) => a.fundKey!))].map((key) => ({ key, name: fundNameOf(key), label: labelOf.get(key)! }))}
        notImported={notImported.map((f) => `${folioName(f)} (${plural(f.schemes.length, "fund")})`)}
        leftOut={leftOutFunds}
        registrar={registrar}
        open={open}
        setOpen={setOpen}
        partId={id("not-included")}
        changeId={(key) => id(`left-change-${key}`)}
        onReopen={reopen}
        onChange={(key) => openEditor(`left|${key}`, itemOf.get(key)!, fundNameOf(key), id(`left-change-${key}`))}
        changePanel={(key) => editor?.rowId === `left|${key}` && changePanel(editor.rowId, itemOf.get(key)!, id(`left-change-${key}`))}
      />
      {counts && <TransactionsSummary breakdown={counts} range={range} partId={id("transactions")} />}
      {(missingNow.length > 0 || error) && (
        <div id={ids.notCreated} tabIndex={-1} className="grid gap-2">
          <NotCreatedAlert accounts={missingNow} nothing="imported" />
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
              <AlertDescription>The review is as you left it.</AlertDescription>
            </Alert>
          )}
          <WrapButton type="button" variant="outline" className="justify-self-start" aria-label="Try again importing transactions" onClick={() => void runImport()} disabled={!canImport}>
            Try again
          </WrapButton>
        </div>
      )}
      {stale && stale.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>Nothing was imported: bank entries you chose changed</AlertTitle>
          <AlertDescription>
            The review now shows them as Wealthfolio has them. Check them, then import again.
            <ul className="list-disc ps-4">
              {stale.map((s) => (
                <li key={s.before.id}>{staleText(s, accountName)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {open.every && current && (
        <section id={ids.every} aria-label="Every transaction on this statement">
          <ActivityTable mapping={current.mapping} plan={plan} sent={sentOf} linked={reused} accounts={allAccounts} label="Every transaction on this statement" />
        </section>
      )}
      <Footer
        summaryId={ids.summary}
        lines={(() => {
          if (busy === "import") {
            return perAccount.map((a) => {
              const name = <span className="font-semibold">{accountName(a.accountId)}</span>;
              return (
                <p key={a.accountId}>
                  {isProposed(a.accountId) && !created.current.has(a.accountId) ? (
                    <>
                      Creating {name} and importing {plural(a.transactions, "transaction")}…
                    </>
                  ) : (
                    <>
                      Importing {plural(a.transactions, "transaction")} into {name}…
                    </>
                  )}
                </p>
              );
            });
          }
          if (renaming) return [<p key="r" className="text-warning">Save or cancel the new account name first.</p>];
          if (prepareError && !nothing) {
            return [
              <p key="x" className="text-destructive">{CANT_PLAN}</p>,
              ...(prepareError.why ? [<p key="why">{prepareError.why}</p>] : []),
            ];
          }
          if (editor) return [<p key="e" className="text-warning">Save or cancel {editWhat} first.</p>];
          if (lookingUp.length) return [<p key="l">Looking up {plural(lookingUp.length, "fund")}…</p>];
          if (questionCount) return [<p key="q">{leftWords}</p>];
          if (nothing) return [<p key="n">Nothing from this statement will be imported.</p>];
          if (!current || !counts) return [<p key="w" className="text-muted-foreground">Working out what will be imported…</p>];
          const see = (
            <p key="see">
              <LinkButton
                type="button"
                aria-expanded={!!open.every}
                aria-controls={ids.every}
                onClick={() => setOpen("every", !open.every)}
              >
                See every transaction
              </LinkButton>
            </p>
          );
          if (!toImport) return [<p key="0">{nothingWords(counts)}</p>, ...answerLine, see];
          return [
            ...perAccount.map((a) => (
              <p key={a.accountId}>
                {isProposed(a.accountId) ? (
                  <>
                    Create the Wealthfolio account <span className="font-semibold">{accountName(a.accountId)}</span> and import{" "}
                    {plural(a.transactions, "transaction")} for {plural(a.funds, "fund")} into it.
                  </>
                ) : (
                  <>
                    Import {plural(a.transactions, "transaction")} for {plural(a.funds, "fund")} into{" "}
                    <span className="font-semibold">{accountName(a.accountId)}</span>.
                  </>
                )}
              </p>
            )),
            ...(differ.length
              ? [
                  <p key="d" className="text-warning">
                    {differ.length === 1 ? "1 fund's units" : `${differ.length} funds' units`} won't match the statement after importing:{" "}
                    {list(differ.map((r) => r.name))}.
                  </p>,
                ]
              : []),
            ...bankLines.map((line) => (
              <p key={line} className="text-muted-foreground">
                {line}
              </p>
            )),
            ...answerLine,
            see,
          ];
        })()}
        action={
          questionCount || lookingUp.length
            ? { label: toImport ? importLabel : "Import", disabled: true }
            : nothing || (current && counts && !toImport)
              ? {
                  label: "Finish",
                  disabled: !!editor || !!renaming,
                  onClick: () => {
                    remember();
                    onAnother(`Finished: nothing from ${fileName} was imported.`);
                  },
                }
              : {
                  label: busy === "import" ? "Saving…" : importLabel,
                  disabled: !canImport,
                  busy: busy === "import",
                  onClick: () => void runImport(),
                }
        }
        go={
          (prepareError || (retrying && !editor)) && !renaming && !nothing
            ? {
                label: "Try again",
                busy: retrying,
                onClick: () => {
                  // With an edit open, the button becomes its Go to it and keeps the focus.
                  retryFrom.current = editor || renaming ? null : document.activeElement;
                  setRetrying(true);
                  // Reads Wealthfolio afresh; answers stay when their question's evidence is unchanged.
                  cache.current = { reads: new Map() };
                  setAttempt((n) => n + 1);
                },
              }
            : renaming
              ? { label: "Go to it", onClick: () => goToRename(renaming.key) }
              : editor
              ? { label: "Go to it", onClick: () => focusSoon(ids.changePanel(editor.rowId), true) }
              : questionCount && !lookingUp.length
                ? { label: questionCount === 1 ? "Go to the question" : "Go to the next question", onClick: () => nextQuestion() }
                : undefined
        }
      />
    </div>
  );
}
