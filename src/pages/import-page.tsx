import type { Account, ActivityDetails, ActivityImport, AddonContext, ImportActivitiesResult } from "@wealthfolio/addon-sdk";
import { QueryKeys } from "@wealthfolio/addon-sdk";
import { Alert, AlertDescription, AlertTitle, Button, Page, PageContent, PageHeader, Spinner } from "@wealthfolio/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Holdings, readHoldings } from "../cas/holdings";
import { closedScheme, type Mapping, mapStatement, withoutClosed } from "../cas/mapping";
import { CasError } from "../cas/parser";
import {
  bankCandidates,
  bankMatches,
  closingUnits,
  type FundUnits,
  importRows,
  indexActivities,
  linkBankRow,
  openingUnits,
  planImport,
  type PlannedTransaction,
  rowsOf,
  sameUnits,
} from "../cas/plan";
import { type CasData, type CasFolio, type CasScheme, isDepository, type Statement } from "../cas/types";
import { type AccountChoices, AccountChoicesCard, accountFor, BankChoicesCard, bankFor } from "../components/account-choices";
import { type FundChoice, FundChoicesCard, fundItems, fundsOf } from "../components/fund-choices";
import { type BankLink, ImportResult, Preview } from "../components/preview";
import { StatementForm } from "../components/statement-form";
import {
  bankKey,
  folioKey,
  fundKey,
  investorKey,
  LEFT_OUT,
  NO_BANK,
  panKey,
  readFund,
  saveFund,
  sourceKey,
} from "../lib/choices";
import { HoldingsImport, holdingItems } from "./holdings-import";

interface Previewed {
  mapping: Mapping;
  plan: PlannedTransaction[];
  /** The bank row each new transaction could use instead of a new one. */
  matches: Map<PlannedTransaction, ActivityDetails>;
}

interface Imported {
  result: ImportActivitiesResult;
  sent: ActivityImport[];
  closing: FundUnits[];
  links: BankLink[];
}

export function ImportPage({ ctx }: { ctx: AddonContext }) {
  const { api } = ctx;
  const [allAccounts, setAllAccounts] = useState<Account[] | null>(null);
  const accounts = allAccounts?.filter((a) => a.isActive && !a.isArchived) ?? null;
  // Wealthfolio values an account that tracks holdings from its snapshots alone, so a detailed
  // statement's transactions go to the others. It treats NOT_SET as transactions.
  const transactionAccounts = accounts?.filter((a) => a.trackingMode !== "HOLDINGS") ?? null;
  const [statement, setStatement] = useState<Statement | null>(null);
  // Summary and depository statements: their holdings, saved as snapshots.
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  // Bumped on every read, so a holdings import starts afresh.
  const [reads, setReads] = useState(0);
  const detailed = statement && !holdings ? (statement as CasData) : null;
  // Closed schemes need no account or fund, so everything after the summary leaves them out.
  const data = useMemo(() => detailed && withoutClosed(detailed), [detailed]);
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
  const [busy, setBusy] = useState<"" | "preview" | "import">("");
  const [error, setError] = useState("");

  useEffect(() => {
    // The host supports includeArchived; the SDK omits this argument.
    (api.accounts.getAll as (includeArchived: boolean) => Promise<Account[]>)(true).then(
      setAllAccounts,
      (e) => setError(`Couldn't load the accounts: ${String(e)}`),
    );
  }, [api]);

  // Remembered accounts that no longer exist are ignored.
  const accountChoices: AccountChoices = Object.fromEntries(
    Object.entries(remembered ?? {}).filter(
      ([, id]) => id === LEFT_OUT || id === NO_BANK || accounts?.some((a) => a.id === id),
    ),
  );
  // So are remembered PAN, folio and bank accounts that track holdings; their rows say why.
  const transactionChoices: AccountChoices = Object.fromEntries(
    Object.entries(accountChoices).filter(([, id]) => id === NO_BANK || transactionAccounts?.some((a) => a.id === id)),
  );
  const holdingsChoices: Record<string, string> = Object.fromEntries(
    Object.entries(accountChoices).flatMap(([key, id]) => {
      const account = accounts?.find((a) => a.id === id && a.trackingMode === "HOLDINGS");
      return account ? [[key, account.name]] : [];
    }),
  );

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

  const clear = () => {
    setStatement(null);
    setHoldings(null);
    setUnbalanced(new Set());
    setPreview(null);
    setImported(null);
    setError("");
  };

  const read = async (full: Statement) => {
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
    await Promise.all([
      ...keys.map(async (key) => {
        const id = await api.storage.get(key).catch(() => null);
        if (id) choices[key] = id;
      }),
      ...fundKeys.map(async (key) => {
        const fund = await readFund(api.storage, key);
        // A holdings import's asset priced from statements isn't for transactions: search for the fund again.
        if (fund && !(isDetailed && fund.statementPrices)) funds[key] = { fund };
      }),
    ]);
    setFundChoices(funds);
    setRemembered(choices);
    setUnbalanced(new Set());
    setHoldings(held);
    setStatement(full);
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
  const chooseFund = (key: string, choice: FundChoice | undefined) => {
    setFundChoices((choices) => ({ ...choices, [key]: choice }));
    changed();
    if (!choice) return;
    choiceWrites.current = choiceWrites.current
      .then(() => ("fund" in choice ? saveFund(api.storage, key, choice.fund) : api.storage.delete(key)))
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
          // A folio whose remembered account tracks holdings needs choosing again, even to go with its PAN.
          const account = folioKey(f) in holdingsChoices ? undefined : accountFor(transactionChoices, f);
          return !choice || ("fund" in choice && !account);
        }),
      )
    : true;

  // A remembered bank account that tracks holdings needs choosing again, and a folio's cash can't
  // move between its account and itself.
  const bankUndecided =
    data?.folios.some((f) => {
      if (!f.schemes.some((s) => target(f, s))) return false;
      const key = bankKey(folioKey(f));
      const inherited = !transactionChoices[key] && f.PAN && bankKey(panKey(f.PAN)) in holdingsChoices;
      const bank = bankFor(transactionChoices, f);
      return key in holdingsChoices || inherited || (!!bank && bank === accountFor(transactionChoices, f));
    }) ?? false;

  const runPreview = async (importUnbalanced = unbalanced) => {
    if (!data) return;
    setBusy("preview");
    setError("");
    setPreview(null);
    setImported(null);
    try {
      const existing = (await Promise.all(accountIds().map((id) => api.activities.getAll(id)))).flat();
      // A fund that starts with units needs Wealthfolio to hold exactly those before the statement.
      const covered = new Set(
        openingUnits(data, target, existing)
          .filter(sameUnits)
          .flatMap((f) => f.schemes),
      );
      const mapping = mapStatement(data, {
        target: (folio, scheme) => {
          const t = target(folio, scheme);
          return t && {
            ...t,
            openingCovered: covered.has(scheme),
            importUnbalanced: importUnbalanced.has(schemeKey(folio.folio, scheme.scheme)),
          };
        },
        alreadyImported: indexActivities(existing).has,
      });
      const rows = rowsOf(mapping);
      const checked = rows.length ? await api.activities.checkImport(rows) : [];
      const plan = planImport(mapping, existing, checked);
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
      setPreview({ mapping, plan, matches: bankMatches(plan, existing, linked) });
      setImportAnyway(new Set());
      setReuse(new Set());
    } catch (e) {
      setError(`Couldn't prepare the preview: ${String(e)}`);
    } finally {
      setBusy("");
    }
  };

  const reused = (t: PlannedTransaction) => reuse.has(t) && !!preview?.matches.has(t);

  const runImport = async () => {
    if (!data || !preview) return;
    const sent = importRows(preview.plan, (t) => importAnyway.has(t), reused);
    setBusy("import");
    setError("");
    try {
      const result = await api.activities.import(sent);
      setPreview(null);
      setImported({ result, sent, closing: [], links: [] });
      // Each reused bank row, once its transaction's trade is in.
      const links: BankLink[] = [];
      for (const t of preview.plan.filter((t) => reused(t) && (t.status === "new" || importAnyway.has(t)))) {
        const bankRow = preview.matches.get(t)!;
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
          error: imported
            ? await linkBankRow(api.activities, t, bankRow)
            : "The trade wasn't imported, so the bank's row was left as it is.",
        });
      }
      setImported({ result, sent, closing: [], links });
      api.query.invalidateQueries([QueryKeys.ACTIVITY_DATA]);
      api.query.invalidateQueries([QueryKeys.ACTIVITIES]);
      try {
        const after = (await Promise.all(accountIds().map((id) => api.activities.getAll(id)))).flat();
        setImported({ result, sent, closing: closingUnits(data, target, after), links });
      } catch {
        setError("The import finished, but the closing units couldn't be checked. Check the holdings in Wealthfolio.");
      }
    } catch (e) {
      setError(`The import failed: ${String(e)}`);
    } finally {
      setBusy("");
    }
  };

  const sendCount = preview ? importRows(preview.plan, (t) => importAnyway.has(t), reused).length : 0;

  return (
    <Page>
      <PageHeader
        heading="CAS Importer"
        text="Import a CAMS, KFintech, NSDL or CDSL statement (CAS PDF). The PDF is read on this device."
      />
      <PageContent>
        <fieldset disabled={busy !== ""} className="min-w-0 space-y-6">
          <StatementForm ctx={ctx} onClear={clear} onRead={read} disabled={busy !== ""} />
          {detailed && <StatementSummary data={detailed} />}
          {statement && holdings && remembered && accounts && (
            <HoldingsImport
              key={reads}
              ctx={ctx}
              statement={statement}
              holdings={holdings}
              accounts={accounts}
              allAccounts={allAccounts!}
              accountChoices={accountChoices}
              onAccount={chooseAccount}
              fundChoices={fundChoices}
              onFund={chooseFund}
              busy={busy}
              setBusy={setBusy}
            />
          )}
          {data && remembered && transactionAccounts && (
            <>
              <AccountChoicesCard
                data={data}
                accounts={transactionAccounts}
                choices={transactionChoices}
                holdingsChoices={holdingsChoices}
                onChange={chooseAccount}
              />
              <BankChoicesCard
                data={data}
                accounts={transactionAccounts}
                choices={transactionChoices}
                holdingsChoices={holdingsChoices}
                onChange={chooseAccount}
              />
              <FundChoicesCard ctx={ctx} items={fundItems(data)} choices={fundChoices} onChange={chooseFund} />
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
              </div>
            </>
          )}
          {error && (
            <Alert variant="destructive">
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
                const next = toggle(unbalanced, schemeKey(w.folio, w.scheme), yes);
                setUnbalanced(next);
                void runPreview(next);
              }}
              matches={preview.matches}
              reuse={reuse}
              onReuse={(t, yes) => setReuse((set) => toggle(set, t, yes))}
              accounts={allAccounts!}
              onImport={() => void runImport()}
              importing={busy === "import"}
              rowCount={sendCount}
            />
          )}
          {imported && (
            <ImportResult result={imported.result} sent={imported.sent} closing={imported.closing} links={imported.links} />
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

function StatementSummary({ data }: { data: CasData }) {
  const schemes = data.folios.flatMap((folio) => folio.schemes);
  const rows = schemes.reduce((count, scheme) => count + scheme.transactions.length, 0);
  const closed = schemes.filter(closedScheme).length;
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        {data.file_type} detailed statement for {data.investor_info.name}, {data.statement_period.from} to{" "}
        {data.statement_period.to}: {data.folios.length} folios, {schemes.length} schemes, {rows} rows.
        {closed > 0 && ` Skipping ${closed} closed ${closed === 1 ? "scheme" : "schemes"}, with no units and nothing to import.`}
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
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
