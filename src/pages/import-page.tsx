import type {
  Account,
  ActivityDetails,
  ActivityImport,
  AddonContext,
  AddonRouteLocation,
  ImportActivitiesResult,
} from "@wealthfolio/addon-sdk";
import { QueryKeys } from "@wealthfolio/addon-sdk";
import { Alert, AlertDescription, AlertTitle, Button, Page, PageContent, PageHeader, Spinner } from "@wealthfolio/ui";
import { useMemo, useRef, useState } from "react";
import { type EntryFacts, readEntryFacts, recheckEntries, reuseBankEntry, type StaleEntry } from "../cas/bank-entries";
import { type Holdings, readHoldings } from "../cas/holdings";
import { closedScheme, type Mapping, mapStatement, withoutClosed, withReadableNames } from "../cas/mapping";
import { CasError } from "../cas/parser";
import {
  bankCandidates,
  bankMatches,
  closingUnits,
  engineTimeZone,
  fundRef,
  fundRefs,
  type FundUnits,
  giftEntries,
  importRows,
  indexActivities,
  openingUnits,
  planImport,
  type PlannedTransaction,
  rowsOf,
  sameUnits,
} from "../cas/plan";
import { type CasData, type CasFolio, type CasScheme, isDepository, type Statement } from "../cas/types";
import {
  type AccountChoices,
  AccountChoicesCard,
  accountFor,
  BankChoicesCard,
  bankFor,
  type Ignored,
} from "../components/account-choices";
import { AmfiBanner, useAmfiCheck } from "../components/amfi-banner";
import { type FundChoice, FundChoicesCard, fundItems, fundsOf } from "../components/fund-choices";
import { type BankLink, ImportResult, Preview, previewCounts } from "../components/preview";
import { StatementForm } from "../components/statement-form";
import {
  bankKey,
  folioKey,
  forgetFund,
  fundKey,
  investorKey,
  LEFT_OUT,
  NO_BANK,
  panKey,
  readFund,
  saveFund,
  sourceKey,
} from "../lib/choices";
import { focusDropped, useFocusMove, useFocusReturn } from "../lib/focus";
import { readableName } from "../lib/fund-name";
import { instrumentType } from "../lib/instrument-type";
import { plural } from "../lib/plural";
import { HoldingsImport, holdingItems } from "./holdings-import";

interface Previewed {
  mapping: Mapping;
  plan: PlannedTransaction[];
  /** The bank row each new transaction could use instead of a new one. */
  matches: Map<PlannedTransaction, ActivityDetails>;
  /** What reusing each of those changes, by its ID. */
  facts: Map<string, EntryFacts>;
  /** Ticked bank rows that changed since the preview, which stopped the last Import. */
  stale?: StaleEntry[];
}

interface Imported {
  result: ImportActivitiesResult;
  sent: ActivityImport[];
  closing: FundUnits[];
  links: BankLink[];
}

/** `location` is the route's, which Wealthfolio passes again each time it shows the page. */
export function ImportPage({ ctx, location }: { ctx: AddonContext; location?: AddonRouteLocation }) {
  const { api } = ctx;
  const amfi = useAmfiCheck(api, location);
  // As of the last read: Wealthfolio keeps this page loaded while the user changes accounts elsewhere.
  const [allAccounts, setAllAccounts] = useState<Account[] | null>(null);
  const accounts = allAccounts?.filter((a) => a.isActive && !a.isArchived) ?? null;
  // Wealthfolio values an account that tracks holdings from its snapshots alone, so a detailed
  // statement's transactions go to the others. It treats NOT_SET as transactions.
  const transactionAccounts = accounts?.filter((a) => a.trackingMode !== "HOLDINGS") ?? null;
  const [statement, setStatement] = useState<Statement | null>(null);
  const [fileName, setFileName] = useState("");
  // Bumped by Use another file, which clears the chosen file.
  const [resets, setResets] = useState(0);
  // What the last review ended with, such as "Finished: nothing … was saved."
  const [notice, setNotice] = useState("");
  // Summary and depository statements: their holdings, saved as snapshots.
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  // Bumped on every read, so a holdings import starts afresh.
  const [reads, setReads] = useState(0);
  const detailed = statement && !holdings ? (statement as CasData) : null;
  // Closed schemes need no account or fund, so everything after the summary leaves them out, and
  // uses each scheme's readable name.
  const data = useMemo(() => detailed && withoutClosed(withReadableNames(detailed)), [detailed]);
  const [remembered, setRemembered] = useState<AccountChoices | null>(null);
  const [fundChoices, setFundChoices] = useState<Record<string, FundChoice | undefined>>({});
  // Storage requests can finish out of order; rereads must wait for these writes too.
  const choiceWrites = useRef(Promise.resolve());
  const [preview, setPreview] = useState<Previewed | null>(null);
  const [importAnyway, setImportAnyway] = useState<Set<PlannedTransaction>>(new Set());
  // Folios' schemes whose rows the user chose to import though they don't add up to the closing balance.
  const [unbalanced, setUnbalanced] = useState<Set<string>>(new Set());
  // Transactions whose bank row in `preview.matches` the user chose to reuse.
  const [reuse, setReuse] = useState<Set<PlannedTransaction>>(new Set());
  const [imported, setImported] = useState<Imported | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "import" | "check">("");
  const [error, setError] = useState("");
  // "Import this fund anyway" previews again, which replaces its checkbox: the new one takes the focus.
  const focus = useFocusMove();
  // Preview the import and Import N activities stay, so they get the focus back. A failed preview
  // from "Import this fund anyway" leaves no checkbox, so its error gets it.
  const focusReturn = useFocusReturn(busy !== "");
  const errorRef = useRef<HTMLDivElement>(null);

  // Remembered accounts that are hidden, archived or no longer listed are ignored, and their rows say why.
  const accountChoices: AccountChoices = Object.fromEntries(
    Object.entries(remembered ?? {}).filter(
      ([, id]) => id === LEFT_OUT || id === NO_BANK || accounts?.some((a) => a.id === id),
    ),
  );
  const unavailable: Record<string, Ignored> = Object.fromEntries(
    Object.entries(remembered ?? {}).flatMap(([key, id]) => {
      // Empty goes with the PAN or the statement.
      if (!allAccounts || !id || key in accountChoices) return [];
      const account = allAccounts.find((a) => a.id === id);
      const state = account && [!account.isActive && "hidden", account.isArchived && "archived"].filter(Boolean).join(" and ");
      return [[key, account ? { name: account.name, state } : {}]];
    }),
  );
  // So are remembered PAN, folio and bank accounts that track holdings.
  const transactionChoices: AccountChoices = Object.fromEntries(
    Object.entries(accountChoices).filter(([, id]) => id === NO_BANK || transactionAccounts?.some((a) => a.id === id)),
  );
  const ignored: Record<string, Ignored> = {
    ...unavailable,
    ...Object.fromEntries(
      Object.entries(accountChoices).flatMap(([key, id]) => {
        const account = accounts?.find((a) => a.id === id && a.trackingMode === "HOLDINGS");
        return account ? [[key, { name: account.name }]] : [];
      }),
    ),
  };

  const target = (folio: CasFolio, scheme: CasScheme) => {
    const accountId = accountFor(transactionChoices, folio);
    const choice = fundChoices[fundKey(scheme)];
    return accountId && choice && "fund" in choice
      ? { accountId, asset: choice.fund, bankAccountId: bankFor(transactionChoices, folio) }
      : undefined;
  };

  // The funds' accounts and their bank accounts.
  const accountIds = () => [
    ...new Set(
      data?.folios.flatMap((f) =>
        f.schemes.flatMap((s) => {
          const t = target(f, s);
          return t ? [t.accountId, ...(t.bankAccountId ? [t.bankAccountId] : [])] : [];
        }),
      ) ?? [],
    ),
  ];

  // Which confirmed fund each asset of `activities` is. A fund without an asset ID goes by the symbol
  // and exchange on each asset's profile; one with an ID needs its asset to still have the symbol,
  // exchange and type its rows are imported with. Either match needs the import's type.
  const fundsIn = async (activities: ActivityDetails[]) => {
    const targets = data?.folios.flatMap((f) => f.schemes.flatMap((s) => target(f, s) ?? [])) ?? [];
    const funds = targets.map((t) => t.asset);
    const accounts = new Set(targets.map((t) => t.accountId));
    const ids = new Set(funds.flatMap((f) => f.assetId ? [f.assetId] : []));
    if (funds.some((f) => !f.assetId)) {
      for (const a of activities) if (a.assetId && accounts.has(a.accountId)) ids.add(a.assetId);
    }
    const profiles = new Map(await Promise.all(
      [...ids].map(async (id) => {
        try {
          const profile = await api.assets.getProfile(id);
          return [id, profile] as const;
        } catch (e) {
          throw new Error(`Couldn't read a Wealthfolio asset's profile: ${String(e)}. Try the preview again. If the asset was deleted, choose its replacement under Funds.`);
        }
      }),
    ));
    const refs = fundRefs(funds, new Map([...profiles].map(([id, p]) => [id, fundRef(p.instrumentSymbol ?? "", p.instrumentExchangeMic)])));
    const byFund = new Map([...refs].map(([id, ref]) => [ref, id]));
    for (const f of funds) {
      const id = f.assetId || byFund.get(fundRef(f.symbol, f.exchangeMic));
      if (!id) continue;
      const profile = profiles.get(id)!;
      if (!profile.instrumentType) {
        throw new Error(`The type of ${f.name} isn't set in Wealthfolio. Set its type there, then under Funds choose Change and confirm the fund again.`);
      }
      if (
        fundRef(profile.instrumentSymbol ?? "", profile.instrumentExchangeMic) !== fundRef(f.symbol, f.exchangeMic) ||
        instrumentType(profile.instrumentType) !== instrumentType(f.instrumentType)
      ) {
        throw new Error(`The symbol, exchange or type of ${f.name} changed in Wealthfolio. Under Funds, choose Change and confirm the fund again.`);
      }
    }
    return refs;
  };

  const clear = () => {
    setStatement(null);
    setHoldings(null);
    setUnbalanced(new Set());
    setPreview(null);
    setImported(null);
    setError("");
  };

  const read = async (full: Statement, name: string) => {
    await choiceWrites.current;
    let keys: string[];
    let fundKeys: string[];
    let held: Holdings | null = null;
    const isDetailed = !isDepository(full) && full.cas_type === "DETAILED";
    if (isDetailed) {
      const next = withoutClosed(full);
      keys = [...new Set(next.folios.flatMap((f) => [folioKey(f), ...(f.PAN ? [panKey(f.PAN)] : [])]))];
      keys.push(...keys.map(bankKey));
      fundKeys = [...fundsOf(next).keys()];
    } else {
      try {
        held = readHoldings(full);
      } catch (e) {
        throw new CasError("parse", e instanceof Error ? e.message : "Couldn't prepare this statement's holdings.");
      }
      keys = [investorKey(held.investor), ...held.sources.map(sourceKey)];
      fundKeys = holdingItems(held).map((item) => item.key);
    }
    const choices: AccountChoices = {};
    const funds: Record<string, FundChoice> = {};
    const [loaded] = await Promise.all([
      // The host supports includeArchived; the SDK omits this argument.
      (api.accounts.getAll as (includeArchived: boolean) => Promise<Account[]>)(true).catch((e) => {
        setError(`Couldn't load the accounts: ${String(e)}. Choose Read statement to try again.`);
        return null;
      }),
      ...keys.map(async (key) => {
        const id = await api.storage.get(key).catch(() => null);
        if (id) choices[key] = id;
      }),
      ...fundKeys.map(async (key) => {
        // Beside a holdings import's asset priced from statements, which isn't for transactions, the
        // fund a detailed import confirmed; without one, the fund is searched for again.
        const fund = await readFund(api.storage, key, isDetailed);
        if (fund) funds[key] = { fund };
      }),
    ]);
    if (!loaded) return;
    setAllAccounts(loaded);
    setFundChoices(funds);
    setRemembered(choices);
    setUnbalanced(new Set());
    setHoldings(held);
    setStatement(full);
    setFileName(name);
    setNotice("");
    setReads((n) => n + 1);
  };

  const changed = () => {
    setPreview(null);
    setImported(null);
  };

  const chooseAccount = (key: string, id: string) => {
    setRemembered((choices) => ({ ...choices, [key]: id }));
    changed();
    choiceWrites.current = choiceWrites.current
      .then(() => (id ? api.storage.set(key, id) : api.storage.delete(key)))
      .catch(() => api.toast.error("Couldn't remember the account."));
  };

  // Undefined (Change, or Choose a fund) keeps what's saved, so a reread restores it. Leaving a
  // fund out forgets it for every folio that shares the key; the left-out state isn't saved.
  // `detailed` is for the Funds card: beside a holdings import's asset priced from statements, its
  // choices change only the fund kept for detailed imports.
  const chooseFund = (key: string, choice: FundChoice | undefined, detailed = false) => {
    setFundChoices((choices) => ({ ...choices, [key]: choice }));
    changed();
    if (!choice) return;
    choiceWrites.current = choiceWrites.current
      .then(() => ("fund" in choice ? saveFund(api.storage, key, choice.fund, detailed) : forgetFund(api.storage, key, detailed)))
      .catch(() =>
        api.toast.error(
          "fund" in choice
            ? "Couldn't remember the fund."
            : "Couldn't forget the fund chosen before. It can come back the next time you read a statement.",
        ),
      );
  };

  const undecided = data
    ? data.folios.some((f) =>
        f.schemes.some((s) => {
          const choice = fundChoices[fundKey(s)];
          // A folio whose remembered account is ignored needs choosing again, even to go with its PAN.
          const account = folioKey(f) in ignored ? undefined : accountFor(transactionChoices, f);
          return !choice || ("fund" in choice && !account);
        }),
      )
    : true;

  // A remembered bank account that's ignored needs choosing again, and a folio's cash can't move
  // between its account and itself.
  const bankUndecided =
    data?.folios.some((f) => {
      if (!f.schemes.some((s) => target(f, s))) return false;
      const key = bankKey(folioKey(f));
      const inherited = !transactionChoices[key] && f.PAN && bankKey(panKey(f.PAN)) in ignored;
      const bank = bankFor(transactionChoices, f);
      return key in ignored || inherited || (!!bank && bank === accountFor(transactionChoices, f));
    }) ?? false;

  /** `unbalancedKey` is the scheme whose "Import this fund anyway" checkbox asked for it. */
  const runPreview = async (importUnbalanced = unbalanced, unbalancedKey?: string) => {
    if (!data) return;
    focus.expect(unbalancedKey ?? null);
    focusReturn.hold(unbalancedKey ? errorRef : undefined);
    setBusy("preview");
    setError("");
    setPreview(null);
    setImported(null);
    try {
      // Groups span accounts; shortcut: the host hides archived activities until its search API includes them.
      const existing = await api.activities.getAll();
      const funds = await fundsIn(existing);
      const timeZone = await engineTimeZone(api.settings);
      // A fund that starts with units needs Wealthfolio to hold exactly those before the statement.
      const covered = new Set(
        openingUnits(data, target, existing, funds, timeZone)
          .filter(sameUnits)
          .flatMap((f) => f.schemes),
      );
      const entered = giftEntries(existing, funds, timeZone);
      const mapping = mapStatement(data, {
        target: (folio, scheme) => {
          const t = target(folio, scheme);
          return t && {
            ...t,
            openingCovered: covered.has(scheme),
            importUnbalanced: importUnbalanced.has(schemeKey(folio.folio, scheme.scheme)),
          };
        },
        alreadyImported: indexActivities(existing, funds).has,
        entered: (row) => entered(row).length > 0,
      });
      const rows = rowsOf(mapping);
      const checked = rows.length ? await api.activities.checkImport(rows) : [];
      const plan = planImport(mapping, existing, checked, funds, timeZone);
      // A bank transfer already linked to another can't be reused.
      const transfers = new Set(
        plan.flatMap((t) => bankCandidates(t, existing)).flatMap((a) => (a.activityType.startsWith("TRANSFER") ? [a.id] : [])),
      );
      const linked = new Set<string>();
      await Promise.all(
        [...transfers].map(async (id) => {
          if (await api.activities.getTransferPair(id)) linked.add(id);
        }),
      );
      const matches = bankMatches(plan, existing, linked);
      const facts = await readEntryFacts(api, [...matches.values()]);
      setPreview({ mapping, plan, matches, facts });
      setImportAnyway(new Set());
      setReuse(new Set());
    } catch (e) {
      setError(`Couldn't prepare the preview: ${String(e)}`);
    } finally {
      setBusy("");
    }
  };

  const reused = (t: PlannedTransaction) => reuse.has(t) && !!preview?.matches.has(t);

  const accountName = (id: string) => allAccounts?.find((a) => a.id === id)?.name ?? "the bank account";

  const runImport = async () => {
    if (!data || !preview) return;
    focusReturn.hold();
    setBusy("import");
    setError("");
    try {
      // The bank rows ticked for transactions about to be imported, as they are now. Any that
      // changed stop the import, and the preview shows them as they are.
      const chosen = preview.plan
        .filter((t) => reused(t) && (t.status === "new" || importAnyway.has(t)))
        .map((t): [PlannedTransaction, ActivityDetails] => [t, preview.matches.get(t)!]);
      let checked: Awaited<ReturnType<typeof recheckEntries>>;
      try {
        checked = await recheckEntries(api, chosen, preview.facts, accountName);
      } catch (e) {
        setError(`Couldn't read the bank rows you chose again, so nothing was imported: ${String(e)}. Choose Import to try again.`);
        return;
      }
      if (checked.stale.length) {
        const matches = new Map(preview.matches);
        const facts = new Map(preview.facts);
        for (const s of checked.stale) if (!checked.current.has(s.transaction)) matches.delete(s.transaction);
        for (const [t, row] of checked.current) {
          matches.set(t, row);
          facts.set(row.id, checked.facts.get(row.id)!);
        }
        setPreview({ ...preview, matches, facts, stale: checked.stale });
        return;
      }
      if (preview.stale) setPreview({ ...preview, stale: undefined });
      const sent = importRows(preview.plan, (t) => importAnyway.has(t), reused);
      const result = await api.activities.import(sent);
      setPreview(null);
      setImported({ result, sent, closing: [], links: [] });
      // Each reused bank row, once its transaction's trade is in.
      const links: BankLink[] = [];
      for (const [t] of chosen) {
        const bankRow = checked.current.get(t)!;
        const line = t.transaction.activity.lineNumber;
        const trade = result.activities.find((a) => a.lineNumber === line);
        const forced = sent.some((r) => r.lineNumber === line && r.forceImport);
        const imported =
          result.summary.success &&
          trade &&
          !Object.keys(trade.errors ?? {}).length &&
          (forced || !(trade.duplicateOfId || trade.duplicateOfLineNumber));
        links.push({
          transaction: t,
          bankRow,
          ...(imported
            ? await reuseBankEntry(api, t, bankRow, checked.facts.get(bankRow.id)!)
            : { error: "The trade wasn't imported, so the bank's row was left as it is.", changes: [], warnings: [] }),
        });
      }
      setImported({ result, sent, closing: [], links });
      api.query.invalidateQueries([QueryKeys.ACTIVITY_DATA]);
      api.query.invalidateQueries([QueryKeys.ACTIVITIES]);
      try {
        const after = (await Promise.all(accountIds().map((id) => api.activities.getAll(id)))).flat();
        const closing = closingUnits(data, target, after, await fundsIn(after), await engineTimeZone(api.settings));
        setImported({ result, sent, closing, links });
      } catch {
        setError("The import finished, but the closing units couldn't be checked. Check the holdings in Wealthfolio.");
      }
    } catch (e) {
      setError(`The import failed: ${String(e)}`);
    } finally {
      setBusy("");
    }
  };

  const reviewing = statement && holdings && remembered && accounts ? { statement, holdings, accounts } : null;

  const sendCount = preview ? importRows(preview.plan, (t) => importAnyway.has(t), reused).length : 0;

  return (
    <Page>
      <PageHeader
        heading="CAS Importer (India)"
        text="Import a CAMS, KFintech, NSDL or CDSL statement (CAS PDF). The PDF is read on this device."
      />
      <PageContent>
        <fieldset disabled={busy !== ""} className="min-w-0 space-y-6">
          {/* While a holdings statement is reviewed, its Questions say what AMFI would change. */}
          {!reviewing && <AmfiBanner amfi={amfi} />}
          {notice && !reviewing && <p className="text-muted-foreground text-sm">{notice}</p>}
          <div hidden={!!reviewing}>
            <StatementForm ctx={ctx} onClear={clear} onRead={read} disabled={busy !== ""} fileRef={amfi.next} reset={resets} />
          </div>
          {detailed && <StatementSummary data={detailed} />}
          {reviewing && (
            <HoldingsImport
              key={reads}
              ctx={ctx}
              statement={reviewing.statement}
              holdings={reviewing.holdings}
              fileName={fileName}
              accounts={reviewing.accounts}
              allAccounts={allAccounts!}
              accountChoices={accountChoices}
              unavailable={unavailable}
              fundChoices={fundChoices}
              amfi={amfi}
              visit={location}
              busy={busy}
              setBusy={setBusy}
              onRemember={({ accounts: picked, funds }) => {
                for (const [key, value] of picked) chooseAccount(key, value);
                for (const [key, choice] of funds) chooseFund(key, choice);
              }}
              onAnother={(said) => {
                clear();
                setResets((n) => n + 1);
                setNotice(said ?? "");
                // A focus moved while the form returns stays where the user put it.
                setTimeout(() => {
                  if (focusDropped()) document.getElementById("cas-file")?.focus();
                });
              }}
            />
          )}
          {data && remembered && transactionAccounts && (
            <>
              <AccountChoicesCard
                data={data}
                accounts={transactionAccounts}
                choices={transactionChoices}
                ignored={ignored}
                onChange={chooseAccount}
              />
              <BankChoicesCard
                data={data}
                accounts={transactionAccounts}
                choices={transactionChoices}
                ignored={ignored}
                onChange={chooseAccount}
              />
              <FundChoicesCard
                ctx={ctx}
                items={fundItems(data)}
                choices={fundChoices}
                amfi={amfi}
                onChange={(key, choice) => chooseFund(key, choice, true)}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" disabled={undecided || bankUndecided || busy !== ""} onClick={() => void runPreview()}>
                  {busy === "preview" && <Spinner />}
                  Preview the import
                </Button>
                {(undecided || bankUndecided) && (
                  <span className="text-muted-foreground text-sm">
                    {undecided
                      ? "Choose an account for each folio and a fund for each scheme first."
                      : "Choose the bank accounts again where they say so first."}
                  </span>
                )}
                {/* Read out while the page is locked, and when the preview is ready. A failed import keeps
                    the preview, and its alert says why, as does an import stopped by changed bank rows. */}
                <p role="status" className="sr-only">
                  {busy === "preview"
                    ? "Preparing the preview…"
                    : busy === "import"
                      ? "Importing…"
                      : preview && !error && !preview.stale
                        ? `The preview is ready: ${previewCounts(preview.plan)}.`
                        : ""}
                </p>
              </div>
            </>
          )}
          {error && (
            <Alert ref={errorRef} tabIndex={-1} variant="destructive">
              <AlertTitle>Something went wrong</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {preview && (
            <Preview
              mapping={preview.mapping}
              plan={preview.plan}
              importAnyway={importAnyway}
              onImportAnyway={(t, yes) => setImportAnyway((set) => toggle(set, t, yes))}
              onImportUnbalanced={(w, yes) => {
                const key = schemeKey(w.folio, w.scheme);
                const next = toggle(unbalanced, key, yes);
                setUnbalanced(next);
                void runPreview(next, key);
              }}
              unbalancedRef={(w) => focus.target(schemeKey(w.folio, w.scheme))}
              matches={preview.matches}
              facts={preview.facts}
              stale={preview.stale}
              reuse={reuse}
              onReuse={(t, yes) => setReuse((set) => toggle(set, t, yes))}
              accounts={allAccounts!}
              onImport={() => void runImport()}
              importing={busy === "import"}
              rowCount={sendCount}
            />
          )}
          {imported && (
            <ImportResult
              result={imported.result}
              sent={imported.sent}
              closing={imported.closing}
              links={imported.links}
              accounts={allAccounts!}
            />
          )}
        </fieldset>
      </PageContent>
    </Page>
  );
}

/** A folio's scheme, as a mapping warning names it. */
const schemeKey = (folio: string, scheme: string) => JSON.stringify([folio, scheme]);

function toggle<T>(set: Set<T>, item: T, yes: boolean) {
  const next = new Set(set);
  if (yes) next.add(item);
  else next.delete(item);
  return next;
}

export function StatementSummary({ data }: { data: CasData }) {
  const schemes = data.folios.flatMap((folio) => folio.schemes);
  const rows = schemes.reduce((count, scheme) => count + scheme.transactions.length, 0);
  const closed = schemes.filter(closedScheme).length;
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        {data.file_type} detailed statement for {data.investor_info.name}, {data.statement_period.from} to{" "}
        {data.statement_period.to}: {plural(data.folios.length, "folio")}, {plural(schemes.length, "scheme")},{" "}
        {plural(rows, "row")}.
        {closed > 0 && ` Skipping ${plural(closed, "closed scheme")}, with no units and nothing to import.`}
      </p>
      {data.parse_warnings.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>casparser reported warnings</AlertTitle>
          <AlertDescription>
            A row or a whole scheme may have been dropped or misread. By default, the preview leaves out each fund
            whose rows don't add up to its closing balance; check anything else these name against the PDF before
            importing.
            <ul className="list-disc ps-4">
              {data.parse_warnings.map((warning) => (
                <li key={warning}>{readableName(warning)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
