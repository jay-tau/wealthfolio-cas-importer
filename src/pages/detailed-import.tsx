import type { Account, ActivityDetails, ActivityImport, AddonContext, ImportActivitiesResult } from "@wealthfolio/addon-sdk";
import { QueryKeys } from "@wealthfolio/addon-sdk";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Spinner } from "@wealthfolio/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { type EntryFacts, readEntryFacts, recheckEntries, reuseBankEntry, type StaleEntry } from "../cas/bank-entries";
import { add, dec, format } from "../cas/decimal";
import { type Mapping, mapStatement } from "../cas/mapping";
import {
  bankCandidates,
  bankMatches,
  closingUnits,
  engineTimeZone,
  fundRef,
  fundRefs,
  type FundRefs,
  type FundUnits,
  giftEntries,
  importRows,
  indexActivities,
  openingUnits,
  planImport,
  type PlannedTransaction,
  rowsOf,
  sameUnits,
  statementDay,
} from "../cas/plan";
import {
  bankMovements,
  bankPairs,
  breakdown,
  fundGroups,
  MOVEMENT,
  plannedOf,
  sends,
  unitsDiffer,
  type Waiting,
} from "../cas/review";
import type { CasData, CasFolio, CasScheme } from "../cas/types";
import { type Ignored, NewAccountLine, type Proposed, type Renaming } from "../components/account-choices";
import type { AmfiCheck } from "../components/amfi-banner";
import { type FundChoice, type FundItem, fundItems } from "../components/fund-choices";
import { type NotCreated, NotCreatedAlert } from "../components/holdings-preview";
import { ActivityTable, type BankLink, ImportResult, staleText } from "../components/preview";
import { BankCheck, type BankCheckModel, checkReceipt, paid } from "../components/review/bank-check";
import {
  BeforeImporting,
  type DuplicateChoice,
  type EarlierFund,
  type LeftOutFund,
  NotIncludedDetailed,
  nothingWords,
  TransactionsSummary,
  type UnbalancedChoice,
} from "../components/review/detailed-parts";
import { useReviewFocus } from "../components/review/focus";
import { Footer } from "../components/review/footer";
import { type FundRow, type FundRowHandlers, FundsReadyTable } from "../components/review/funds-ready";
import { ReviewHeader } from "../components/review/header";
import { Disclosure, LinkButton, shownName, useWide, WrapButton } from "../components/review/parts";
import { AnsweredLine, answerWords, Picker, pickerIds, QuestionCard } from "../components/review/question";
import { folioName, type FundsBox, SaveToDetailed } from "../components/review/save-to-detailed";
import { useHoldingSearches } from "../components/review/search";
import { bankKey, type ChosenFund, folioKey, fundKey, LEFT_OUT, NO_BANK, panKey } from "../lib/choices";
import { readableName } from "../lib/fund-name";
import { instrumentType } from "../lib/instrument-type";
import { nameNumber } from "../lib/name-number";
import { isProposed, nameProblem, newAccount, proposalKey, proposedId, proposedNames } from "../lib/new-accounts";
import { plural } from "../lib/plural";
import { longDate, rupees, units } from "../lib/review-format";
import { sha256 } from "../lib/sha256";

type Busy = "" | "preview" | "import" | "check";

/** What the import did, shown in place of the review until Phase 3's Done screen. */
interface Imported {
  result: ImportActivitiesResult;
  sent: ActivityImport[];
  closing: FundUnits[];
  links: BankLink[];
  /** New accounts Wealthfolio didn't create. */
  notCreated: NotCreated[];
  /** What waits for them. */
  held?: Part[];
  /** Creates them and imports what waits. */
  retry?: () => void;
}

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
const list = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2019-04-01" → "Apr 2019". */
const month = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
/** The planned transaction's own key, which stays the same as the plan is worked out again. */
const transactionKey = (t: PlannedTransaction) => t.transaction.activity.sourceRecordId ?? `line:${t.transaction.activity.lineNumber}`;
/** A transaction's movement in words: "purchase", "sale". */
const noun = (t: PlannedTransaction, accountId = t.transaction.activity.accountId) => {
  const received = t.transaction.receiving?.activity;
  const activity = received?.accountId === accountId ? received : t.transaction.activity;
  return (MOVEMENT[t.transaction.rows[0].type] ?? activityLabel(activity)).toLowerCase();
};
const LABELS: Record<string, string> = {
  BUY: "Purchase", SELL: "Sale", DIVIDEND: "Dividend", TRANSFER_IN: "Gift received", TRANSFER_OUT: "Gift given", ADJUSTMENT: "Merger",
};
const activityLabel = (row: ActivityImport) => (row.activityType === "DIVIDEND" && row.subtype === "DRIP" ? "Reinvested dividend" : LABELS[row.activityType] ?? row.activityType);

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
  const [importAnyway, setImportAnyway] = useState<ReadonlySet<string>>(new Set());
  const [unbalanced, setUnbalanced] = useState<ReadonlySet<string>>(new Set());
  // Each bank check's answer and ticks, for the pairs they were given for.
  const [checkAnswers, setCheckAnswers] = useState<Record<string, BankAnswer>>({});
  const [ticks, setTicks] = useState<Record<string, { signature: string; keys: string[]; changed: boolean }>>({});
  const [showAll, setShowAll] = useState(false);
  const [open, setOpenState] = useState<Record<string, boolean>>({});
  const setOpen = (key: string, yes: boolean) => setOpenState((all) => ({ ...all, [key]: yes }));
  const [editor, setEditor] = useState<Editor | null>(null);
  const [nag, setNag] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [openedSettings, setOpenedSettings] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [prepareError, setPrepareError] = useState("");
  const [imported, setImportedState] = useState<Imported | null>(null);
  // The latest result, for Try again, which goes on from it.
  const latestImported = useRef<Imported | null>(null);
  const setImported = (next: Imported) => {
    latestImported.current = next;
    setImportedState(next);
  };
  // Accounts the last import couldn't create; it imported nothing else, so the review stays.
  const [notCreated, setNotCreated] = useState<NotCreated[]>([]);
  // Bumped by each Try again, so its result takes the focus again.
  const [retries, setRetries] = useState(0);
  const [stale, setStale] = useState<StaleEntry[] | null>(null);
  const [error, setError] = useState("");
  // Bumped when the page is opened again, Try again is pressed or bank entries changed: Wealthfolio may have changed meanwhile.
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
        return announce("error" in outcome ? `The search didn't work: ${outcome.error}` : `Nothing found for “${outcome.text}”. Check the code.`);
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
  const signature = JSON.stringify([
    generation,
    data.folios.map((f) => [folioState(f), accountOf(f) ?? "", bankOf(f) ?? ""]),
    items.map((item) => fundOf(item.key) ?? null),
    [...unbalanced].sort(),
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
    setPrepareError("");
    prepare(signature).then(
      (next) => {
        if (run !== latestPrepare.current) return;
        setPrepared(next);
        settleRetry(true);
      },
      (e) => {
        if (run !== latestPrepare.current) return;
        setPrepareError(`Couldn't work out what will be imported: ${String(e)}`);
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
        return t && { ...t, openingCovered: covered.has(scheme), importUnbalanced: unbalanced.has(schemeKey(folio.folio, scheme.scheme)) };
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
    return { signature, existing, funds, timeZone, mapping, plan, linked, facts, opening };
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
            throw new Error(`Couldn't read a Wealthfolio asset's profile: ${String(e)}. Try again. If the asset was deleted, choose Change beside its fund and pick its replacement.`);
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
        throw new Error(`The type of ${f.name} isn't set in Wealthfolio. Set its type there, then choose Change beside the fund and confirm it again.`);
      }
      if (
        fundRef(profile.instrumentSymbol ?? "", profile.instrumentExchangeMic) !== fundRef(f.symbol, f.exchangeMic) ||
        instrumentType(profile.instrumentType) !== instrumentType(f.instrumentType)
      ) {
        throw new Error(`The symbol, exchange or type of ${f.name} changed in Wealthfolio. Choose Change beside the fund and confirm it again.`);
      }
    }
    return refs;
  }

  // What the plan sends, and what the review says about it.
  const plan = current?.plan ?? [];
  const planned = plannedOf(plan);
  const existingById = new Map((current?.existing ?? []).map((a) => [a.id, a]));
  // A match by value may be another transaction; a row imported by this add-on isn't forced again.
  const canImportAnyway = (t: PlannedTransaction) => !t.transaction.arriving && (
    t.status === "duplicate" || (t.status === "existing" && t.rows.some((r) =>
      r.existingId && !existingById.get(r.existingId)?.sourceRecordId?.startsWith("addon:cas-importer:")))
  );
  const forced = (t: PlannedTransaction) => canImportAnyway(t) && importAnyway.has(transactionKey(t));
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
            ? `Includes the second ${noun(sentPlan.find((t) => t.status !== "new" && groupsOfTransaction(t).includes(group.key))!, group.accountId)} you chose.`
            : `Includes the ${group.forced} possible duplicates you chose.`
          : group.other
            ? `${plural(group.other, "transaction")} of this fund ${group.other === 1 ? "isn't" : "aren't"} imported now.`
            : "Wealthfolio's other transactions of this fund differ from the statement.";
      note = `After import: ${units(format(group.after!))} units · Statement: ${units(format(group.statement))}. ${why}`;
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
  const counts = current ? breakdown({ mapping: current.mapping, planned, sent: sentOf, why }) : undefined;
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
  const defaultedSchemes = new Set((current?.mapping.warnings ?? []).filter((w) => w.unbalanced && w.leftOut).map((w) => schemeKey(w.folio, w.scheme)));
  const defaulted = [...new Set(data.folios.flatMap((f) => f.schemes.filter((s) => defaultedSchemes.has(schemeKey(f.folio, s.scheme))).map(fundKey)))]
    .map((key) => ({ key, name: itemOf.get(key)!.name, label: labelOf.get(key)! }));
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

  // Today's other preview decisions: possible duplicates, and funds whose rows don't add up.
  const offered = plan.filter(canImportAnyway);
  const duplicates: DuplicateChoice[] = offered.map((t) => {
    const { activity, rows: [first] } = t.transaction;
    const what = noun(t);
    const name = shownName(itemOf.get(fundKey(schemeOf(t)!))!, fundOf(fundKey(schemeOf(t)!)));
    // The amount the statement prints, as the user can find it there.
    const amount = first.amount?.replace(/^-/, "") ?? activity.amount ?? t.transaction.cash?.amount;
    const title = [name, MOVEMENT[first.type] ?? activityLabel(activity), longDate(String(activity.date)), amount ? rupees(String(amount)) : ""].filter(Boolean).join(" · ");
    const row = t.rows.find((r) => r.existingId || r.repeatsLine !== undefined || r.flagged);
    const reason = row?.existingId
      ? `Wealthfolio already has this ${what}, entered by hand or imported without the add-on's row ID.`
      : row?.repeatsLine !== undefined
        ? `This ${what} equals another one on this statement.`
        : `Wealthfolio reports this ${what} as a duplicate.`;
    return { key: transactionKey(t), title, reason, label: title, noun: what, checked: forced(t) };
  });
  const duplicateNames = duplicates.map((d) => ({ name: d.title }));
  duplicates.forEach((d, i) => { d.label += nameNumber(duplicateNames, i, "transaction"); });
  function schemeOf(t: PlannedTransaction) {
    return current?.mapping.outcomes.find((o) => o.transaction === t.transaction && o.row === t.transaction.rows[0])?.scheme;
  }
  const unbalancedChoices: UnbalancedChoice[] = (current?.mapping.warnings ?? [])
    .filter((w) => w.unbalanced)
    .map((w) => {
      const key = schemeKey(w.folio, w.scheme);
      return { key, title: `${w.scheme}, folio ${w.folio}`, gap: w.message.replace(/ (None of this fund's rows|Its rows are imported anyway).*$/, ""), checked: unbalanced.has(key) };
    });

  // While a tick works the plan out again, Before importing keeps the last plan's items, with the
  // ticks as they are now, so the checkbox pressed keeps the focus.
  const lastBefore = useRef<{ duplicates: DuplicateChoice[]; unbalanced: UnbalancedChoice[] } | null>(null);
  if (current) lastBefore.current = { duplicates, unbalanced: unbalancedChoices };
  const before = current || prepareError || !lastBefore.current
    ? { duplicates, unbalanced: unbalancedChoices }
    : {
        duplicates: lastBefore.current.duplicates.map((d) => ({ ...d, checked: importAnyway.has(d.key) })),
        unbalanced: lastBefore.current.unbalanced.map((u) => ({ ...u, checked: unbalanced.has(u.key) })),
      };

  // Fund lines, by box: what the counts say.
  const lines = boxes.flatMap((box) =>
    [...new Set(box.folios.flatMap((f) => f.schemes.map(fundKey)))].map((key) => ({ box, key })),
  );
  const lineState = ({ box, key }: { box: FundsBox; key: string }) => {
    const schemes = box.folios.flatMap((f) => f.schemes.filter((s) => fundKey(s) === key).map((scheme) => ({ folio: f, scheme })));
    const outcomes = (current?.mapping.outcomes ?? []).filter((o) => box.folios.includes(o.folio) && fundKey(o.scheme) === key);
    if (outcomes.some((o) => o.transaction && sentOf(planned.get(o.transaction)!))) return "ready";
    if ((questionKeys.includes(key) && schemes.some(({ folio }) => included(folio))) || schemes.some(({ folio }) => undecidedFolios.includes(folio))) return "question";
    if (schemes.every(({ folio, scheme }) => target(folio, scheme) && !blockedSchemes.has(schemeKey(folio.folio, scheme.scheme))) && outcomes.every((o) => o.transaction && planned.get(o.transaction)?.status === "existing")) return "nothing";
    return "out";
  };
  const states = lines.map(lineState);
  const readyCount = states.filter((s) => s === "ready").length;
  const outCount = states.filter((s) => s === "out").length;

  const answeredAll = openKeys.length === 0 && lookingUp.length === 0 && !accountQuestion;
  const questionCount = openKeys.length + (accountQuestion ? 1 : 0) + openChecks.length;
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
    focusSoon(ids.summary, force);
  };

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
    else focusSoon(openKeys.length ? ids.question(openKeys[0]) : ids.summary, false, batch.origin);
  });

  // After the last answer, the focus goes on to what's left, or to the summary.
  const afterAnswer = useRef(false);
  const afterChange = useRef<string | null>(null);
  useEffect(() => {
    if (!current) return;
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
    Object.keys(answers).length + importAnyway.size + unbalanced.size + Object.keys(checkAnswers).length + Object.values(ticks).filter((t) => t.changed).length +
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

  /**
   * Imports the transactions the review approved. Each new account a transaction's rows go to is
   * created first; a transaction that needs one Wealthfolio didn't create waits whole, with both
   * sides of a gift and a trade's bank transfer, and the others are imported. A transaction going to
   * a new account is checked once it's created; one Wealthfolio refuses stays out, with its message.
   * Try again goes on from what waits, with the review as it was, and never creates an account twice.
   */
  const runImport = async () => {
    if (!current) return;
    remember();
    // Firefox keeps the focus on the pressed button while it's disabled; the others drop it.
    const pressed = document.activeElement;
    setBusy("import");
    setError("");
    setNotCreated([]);
    const made: Account[] = [];
    const nowRemembered: [string, string][] = [];
    try {
      // Re-read what the user accepted, even when revisiting refreshed the plan behind the receipt.
      const approved = new Map(checks.flatMap((c) => answerOf(c)?.linked ? [...answerOf(c)!.shown] : []));
      const chosen = sentPlan.filter(reused).map((t): [PlannedTransaction, ActivityDetails] => [t, approved.get(matches.get(t)!.id)!.entry]);
      const shownFacts = new Map([...approved].map(([entryId, shown]) => [entryId, shown.facts]));
      let checked: Awaited<ReturnType<typeof recheckEntries>>;
      try {
        checked = await recheckEntries(api, chosen, shownFacts, accountName);
      } catch (e) {
        setError(`Couldn't read the bank entries you chose again, so nothing was imported: ${String(e)}. Try again.`);
        return;
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
      // What the review chose, kept for Try again: the plan behind it can change once accounts exist.
      const choiceKeys = [...boxes.map((b) => b.key), ...data.folios.map(folioKey)];
      const pointing = new Map<string, string[]>();
      for (const key of choiceKeys) {
        const value = valueOf(key);
        if (isProposed(value)) pointing.set(value, [...(pointing.get(value) ?? []), key]);
      }
      const reviewed = { target, groups, fundsIn };

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
            for (const key of pointing.get(accountId) ?? []) remembered.push([key, account.id]);
          } catch (e) {
            // Its name stays as shown while other new accounts take theirs.
            tried.current[proposalKey(accountId)] = name;
            missing.push({ accountId, name, error: String(e) });
          }
        }
        return missing;
      };

      const importParts = async (parts: Part[], before: Imported | null, made: Account[], remembered: [string, string][]) => {
        const missing = await createAccounts([...new Set(parts.flatMap((p) => p.rows.map((r) => r.accountId)).filter(isProposed))], made, remembered);
        // Creation can succeed even when the following check or import fails.
        if (before) setImported({ ...before, notCreated: missing });
        const blocked = new Set(missing.map((m) => m.accountId));
        const held = parts.filter((p) => p.rows.some((r) => blocked.has(r.accountId)));
        let ready = parts.filter((p) => !held.includes(p));
        // Rows for an account this review created are checked there before anything is imported.
        const fresh = ready.flatMap((p) => p.rows.filter((r) => isProposed(r.accountId)).map((row) => ({ p, row })));
        const refused: ActivityImport[] = [];
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
        if (!before && !ready.length && !refused.length) return { missing, imported: null };
        const sent = ready.flatMap((p) => p.rows.map(inCreated));
        let result: ImportActivitiesResult = sent.length
          ? await api.activities.import(sent)
          : { activities: [], importRunId: "", summary: { total: 0, imported: 0, skipped: 0, duplicates: 0, assetsCreated: 0, success: true } };
        if (refused.length) {
          // Reported as rows Wealthfolio rejected.
          const summary = result.summary;
          result = {
            ...result,
            activities: [...result.activities, ...refused],
            summary: { ...summary, total: (summary.total ?? 0) + refused.length, skipped: (summary.skipped ?? 0) + refused.length },
          };
        }
        const allSent = [...(before?.sent ?? []), ...sent];
        const retry = held.length ? () => again(held) : undefined;
        let shown: Imported = { result: before ? mergeResults(before.result, result) : result, sent: allSent, closing: before?.closing ?? [], links: before?.links ?? [], notCreated: missing, held, retry };
        setImported(shown);
        // Each bank entry used, once its transaction's trade is in.
        const links = [...shown.links];
        for (const p of ready.filter((p) => p.entry)) {
          const line = p.t.transaction.activity.lineNumber;
          const trade = result.activities.find((a) => a.lineNumber === line);
          const wasForced = sent.some((r) => r.lineNumber === line && r.forceImport);
          const ok =
            result.summary.success && trade && !Object.keys(trade.errors ?? {}).length && (wasForced || !(trade.duplicateOfId || trade.duplicateOfLineNumber));
          links.push({
            transaction: p.t,
            bankRow: p.entry!.row,
            ...(ok
              ? await reuseBankEntry(api, transactionInCreated(p.t), p.entry!.row, p.entry!.facts)
              : { error: "The trade wasn't imported, so the bank's entry was left as it is.", changes: [], warnings: [] }),
          });
        }
        shown = { ...shown, links };
        setImported(shown);
        api.query.invalidateQueries([QueryKeys.ACTIVITY_DATA]);
        api.query.invalidateQueries([QueryKeys.ACTIVITIES]);
        try {
          // Each fund's units, in the accounts that exist now; a fund whose account wasn't created isn't checked.
          const inAccount = (f: CasFolio, s: CasScheme) => {
            const t = reviewed.target(f, s);
            if (!t || (isProposed(t.accountId) && !created.current.has(t.accountId))) return undefined;
            return { ...t, accountId: created.current.get(t.accountId)?.id ?? t.accountId };
          };
          const touched = new Set(reviewed.groups.filter((g) => g.sent > 0 && !blocked.has(g.accountId)).flatMap((g) => g.schemes.map((s) => s.scheme)));
          const accountIds = [...new Set(data.folios.flatMap((f) => f.schemes.flatMap((s) => {
            const t = touched.has(s) ? inAccount(f, s) : undefined;
            return t ? [t.accountId, ...(t.bankAccountId ? [t.bankAccountId] : [])] : [];
          })))];
          const after = (await Promise.all(accountIds.map((accountId) => api.activities.getAll(accountId)))).flat();
          const target = (f: CasFolio, s: CasScheme) => (touched.has(s) ? inAccount(f, s) : undefined);
          const funds = await reviewed.fundsIn(after, (assetId) => api.assets.getProfile(assetId), target);
          shown = { ...shown, closing: closingUnits(data, target, after, funds, await engineTimeZone(api.settings)) };
          setImported(shown);
        } catch {
          setError("The import finished, but the closing units couldn't be checked. Check the holdings in Wealthfolio.");
        }
        return { missing, imported: shown };
      };

      // Try again: the accounts still to create, then what waited for them.
      const again = async (held: Part[]) => {
        setBusy("import");
        setError("");
        const made: Account[] = [];
        const remembered: [string, string][] = [];
        try {
          // The bank entries chosen are read again, as before the first import.
          const linking = held.filter((p) => p.entry).map((p): [PlannedTransaction, ActivityDetails] => [p.t, p.entry!.row]);
          if (linking.length) {
            const latest = await recheckEntries(api, linking, new Map(held.flatMap((p) => (p.entry ? [[p.entry.row.id, p.entry.facts] as const] : []))), accountName);
            if (latest.stale.length) {
              setError("A bank entry you chose changed since the import, so nothing more was imported. Read the statement again to review it.");
              return;
            }
          }
          await importParts(held, latestImported.current, made, remembered);
          setRetries((n) => n + 1);
        } catch (e) {
          setError(`The import failed: ${String(e)}`);
        } finally {
          settleCreated(made, remembered);
          setBusy("");
        }
      };

      const { missing, imported: done } = await importParts(parts, null, made, nowRemembered);
      if (!done && missing.length) {
        // Nothing was imported: the review stays as it was, saying which accounts weren't created.
        setNotCreated(missing);
        announce(`Nothing was imported: Wealthfolio didn't create ${missing.length === 1 ? `the account ${missing[0].name}` : `${missing.length} accounts`}.`);
        focusSoon(ids.notCreated, false, pressed);
      }
    } catch (e) {
      setError(`The import failed: ${String(e)}`);
    } finally {
      settleCreated(made, nowRemembered);
      setBusy("");
    }
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
    <p role="status" className="sr-only">
      {busy === "import" ? "Importing…" : said}
    </p>
  );

  if (imported) {
    return (
      <div className="grid gap-6">
        {header}
        {status}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <ImportResult
          key={retries}
          result={imported.result}
          sent={imported.sent}
          closing={imported.closing}
          links={imported.links}
          accounts={[...allAccounts, ...created.current.values()]}
          notCreated={imported.notCreated}
          waiting={(account) => {
            const n = (imported.held ?? []).filter((p) => p.rows.some((r) => r.accountId === account.accountId)).length;
            return `${plural(n, "transaction")} for it ${n === 1 ? "wasn't" : "weren't"} imported.`;
          }}
          retry={imported.retry}
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
  const anyQuestions = questionKeys.length > 0 || answeredKeys.length > 0;
  const fundNameOf = (key: string) => shownName(itemOf.get(key)!, fundOf(key));
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
    const fundOnly = !accountQuestion;
    const checkWords = bank === 1 ? "the payment check" : `${bank} payment checks`;
    if (bank && others) return `${plural(questionCount, "question")} left: ${checkWords} and ${plural(others, fundOnly ? "fund question" : "other question")} before importing.`;
    if (bank) return `${plural(questionCount, "question")} left: ${checkWords} before importing.`;
    return `${plural(questionCount, "question")} left before importing.`;
  })();
  const toImport = counts?.toImport ?? 0;
  // The new accounts the import creates first.
  const creating = perAccount.filter((a) => isProposed(a.accountId)).length;
  const importLabel = creating
    ? `Create ${creating === 1 ? "account" : `${creating} accounts`} and import ${plural(toImport, "transaction")}`
    : `Import ${plural(toImport, "transaction")}`;
  const range = `${month(from)} to ${month(to)}`;

  return (
    <div className="space-y-6">
      {header}
      {status}
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
            A row or a whole scheme may have been dropped or misread. By default, the import leaves out each fund whose rows don't add up to its
            closing balance; check anything else these name against the PDF before importing.
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
      {prepareError && (
        <Alert variant="destructive">
          <AlertTitle>Couldn't prepare the import</AlertTitle>
          <AlertDescription>
            <p>{prepareError}</p>
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
            {openChecks.length > 0 && openKeys.length > 0 ? (accountQuestion ? "Other questions" : "Fund questions") : "Questions for you"}
            {openKeys.length > 0 && ` · ${openKeys.length} of ${openKeys.length + answeredKeys.length} left`}
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
                    variant={openedSettings ? "outline" : "default"}
                    onClick={() => {
                      setOpenedSettings(true);
                      amfi.openSettings();
                    }}
                  >
                    Open Market data settings
                  </WrapButton>
                  {openedSettings && (
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
          {openKeys.length === 0 && answeredKeys.length > 0 && lookingUp.length === 0 ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-2 rounded-lg border p-3">
              <span aria-hidden="true" className="text-success">
                ✓
              </span>
              <span>{answeredKeys.length === 1 ? "Question answered." : `All ${answeredKeys.length} questions answered.`}</span>
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
        notImported={notImported.map((f) => `${folioName(f)} (${plural(f.schemes.length, "fund")})`)}
        defaulted={defaulted}
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
      {answeredAll && (
        <BeforeImporting
          duplicates={before.duplicates}
          unbalanced={before.unbalanced}
          onDuplicate={(key, yes) =>
            setImportAnyway((all) => {
              const next = new Set(all);
              if (yes) next.add(key);
              else next.delete(key);
              return next;
            })
          }
          onUnbalanced={(key, yes) =>
            setUnbalanced((all) => {
              const next = new Set(all);
              if (yes) next.add(key);
              else next.delete(key);
              return next;
            })
          }
          disabled={busy !== ""}
          headingId={ids.before}
        />
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {missingNow.length > 0 && (
        <div id={ids.notCreated} tabIndex={-1} className="grid gap-2">
          <NotCreatedAlert accounts={missingNow} what={() => "Nothing was imported."} />
          <WrapButton type="button" variant="outline" className="justify-self-start" onClick={() => void runImport()} disabled={!!editor || !!renaming || !current || !toImport}>
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
          if (busy === "import") return [<p key="i">Importing…</p>];
          if (renaming) return [<p key="r" className="text-warning">Save or cancel the new account name first.</p>];
          if (prepareError && !nothing) return [<p key="x" className="text-destructive">{prepareError}</p>];
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
          if (!toImport) return [<p key="0">{nothingWords(counts)}</p>, see];
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
                  label: busy === "import" ? "Importing…" : importLabel,
                  disabled: !current || !!editor || !!renaming || busy !== "" || !!prepareError || !toImport,
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
                  cache.current = { reads: new Map() };
                  setGeneration((n) => n + 1);
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
