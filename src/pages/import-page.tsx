import type { Account, ActivityImport, AddonContext, ImportActivitiesResult } from "@wealthfolio/addon-sdk";
import { QueryKeys } from "@wealthfolio/addon-sdk";
import { Alert, AlertDescription, AlertTitle, Button, Page, PageContent, PageHeader, Spinner } from "@wealthfolio/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Holdings, readHoldings } from "../cas/holdings";
import { closedScheme, type Mapping, mapStatement, withoutClosed } from "../cas/mapping";
import { CasError } from "../cas/parser";
import {
  closingUnits,
  type FundUnits,
  importRows,
  indexActivities,
  openingUnits,
  planImport,
  type PlannedTransaction,
  rowsOf,
  sameUnits,
} from "../cas/plan";
import { type CasData, type CasFolio, type CasScheme, isDepository, type Statement } from "../cas/types";
import { type AccountChoices, AccountChoicesCard, accountFor } from "../components/account-choices";
import { type FundChoice, FundChoicesCard, fundItems, fundsOf } from "../components/fund-choices";
import { ImportResult, Preview } from "../components/preview";
import { StatementForm } from "../components/statement-form";
import { folioKey, fundKey, investorKey, LEFT_OUT, panKey, readFund, saveFund, sourceKey } from "../lib/choices";
import { HoldingsImport, holdingItems } from "./holdings-import";

interface Previewed {
  mapping: Mapping;
  plan: PlannedTransaction[];
}

interface Imported {
  result: ImportActivitiesResult;
  sent: ActivityImport[];
  closing: FundUnits[];
}

export function ImportPage({ ctx }: { ctx: AddonContext }) {
  const { api } = ctx;
  const [allAccounts, setAllAccounts] = useState<Account[] | null>(null);
  const accounts = allAccounts?.filter((a) => a.isActive && !a.isArchived) ?? null;
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
    Object.entries(remembered ?? {}).filter(([, id]) => id === LEFT_OUT || accounts?.some((a) => a.id === id)),
  );

  const target = (folio: CasFolio, scheme: CasScheme) => {
    const accountId = accountFor(accountChoices, folio);
    const choice = fundChoices[fundKey(scheme)];
    return accountId && choice && "fund" in choice ? { accountId, asset: choice.fund } : undefined;
  };

  const accountIds = () => [
    ...new Set(data?.folios.flatMap((f) => f.schemes.flatMap((s) => target(f, s)?.accountId ?? [])) ?? []),
  ];

  const clear = () => {
    setStatement(null);
    setHoldings(null);
    setPreview(null);
    setImported(null);
    setError("");
  };

  const read = async (full: Statement) => {
    await choiceWrites.current;
    let keys: string[];
    let fundKeys: string[];
    let held: Holdings | null = null;
    if (!isDepository(full) && full.cas_type === "DETAILED") {
      const next = withoutClosed(full);
      keys = [...new Set(next.folios.flatMap((f) => [folioKey(f), ...(f.PAN ? [panKey(f.PAN)] : [])]))];
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
        if (fund) funds[key] = { fund };
      }),
    ]);
    setFundChoices(funds);
    setRemembered(choices);
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
          return !choice || ("fund" in choice && !accountFor(accountChoices, f));
        }),
      )
    : true;

  const runPreview = async () => {
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
          return t && { ...t, openingCovered: covered.has(scheme) };
        },
        alreadyImported: indexActivities(existing).has,
      });
      const rows = rowsOf(mapping);
      const checked = rows.length ? await api.activities.checkImport(rows) : [];
      setPreview({ mapping, plan: planImport(mapping, existing, checked) });
      setImportAnyway(new Set());
    } catch (e) {
      setError(`Couldn't prepare the preview: ${String(e)}`);
    } finally {
      setBusy("");
    }
  };

  const runImport = async () => {
    if (!data || !preview) return;
    const sent = importRows(preview.plan, (t) => importAnyway.has(t));
    setBusy("import");
    setError("");
    try {
      const result = await api.activities.import(sent);
      setPreview(null);
      setImported({ result, sent, closing: [] });
      api.query.invalidateQueries([QueryKeys.ACTIVITY_DATA]);
      api.query.invalidateQueries([QueryKeys.ACTIVITIES]);
      try {
        const after = (await Promise.all(accountIds().map((id) => api.activities.getAll(id)))).flat();
        setImported({ result, sent, closing: closingUnits(data, target, after) });
      } catch {
        setError("The import finished, but the closing units couldn't be checked. Check the holdings in Wealthfolio.");
      }
    } catch (e) {
      setError(`The import failed: ${String(e)}`);
    } finally {
      setBusy("");
    }
  };

  const sendCount = preview ? importRows(preview.plan, (t) => importAnyway.has(t)).length : 0;

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
          {data && remembered && accounts && (
            <>
              <AccountChoicesCard data={data} accounts={accounts} choices={accountChoices} onChange={chooseAccount} />
              <FundChoicesCard ctx={ctx} items={fundItems(data)} choices={fundChoices} onChange={chooseFund} />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" disabled={undecided || busy !== ""} onClick={() => void runPreview()}>
                  {busy === "preview" && <Spinner />}
                  Preview the import
                </Button>
                {undecided && (
                  <span className="text-muted-foreground text-sm">
                    Choose an account for each folio and a fund for each scheme first.
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
              onImportAnyway={(t, yes) =>
                setImportAnyway((set) => {
                  const next = new Set(set);
                  if (yes) next.add(t);
                  else next.delete(t);
                  return next;
                })
              }
              onImport={() => void runImport()}
              importing={busy === "import"}
              rowCount={sendCount}
            />
          )}
          {imported && <ImportResult result={imported.result} sent={imported.sent} closing={imported.closing} />}
        </fieldset>
      </PageContent>
    </Page>
  );
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
          <AlertTitle>casparser found rows that don't add up</AlertTitle>
          <AlertDescription>
            A row was probably dropped or misread. Check these schemes against the PDF before importing.
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
