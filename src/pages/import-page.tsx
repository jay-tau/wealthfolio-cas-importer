import type { Account, AddonContext, AddonRouteLocation } from "@wealthfolio/addon-sdk";
import { Page, PageContent, PageHeader } from "@wealthfolio/ui";
import { useMemo, useRef, useState } from "react";
import { type Holdings, readHoldings } from "../cas/holdings";
import { withoutClosed, withReadableNames } from "../cas/mapping";
import { CasError } from "../cas/parser";
import { type CasData, isDepository, type Statement } from "../cas/types";
import type { Ignored } from "../components/account-choices";
import { AmfiBanner, useAmfiCheck } from "../components/amfi-banner";
import { type FundChoice, fundsOf } from "../components/fund-choices";
import { StatementForm } from "../components/statement-form";
import { bankKey, folioKey, forgetFund, investorKey, LEFT_OUT, NO_BANK, panKey, readFund, saveFund, sourceKey } from "../lib/choices";
import { focusDropped } from "../lib/focus";
import { DetailedImport } from "./detailed-import";
import { HoldingsImport, holdingItems } from "./holdings-import";

/** Remembered: a choice's storage key → account ID, `LEFT_OUT` or `NO_BANK`. */
type AccountChoices = Record<string, string>;

/** `location` is the route's, which Wealthfolio passes again each time it shows the page. */
export function ImportPage({ ctx, location }: { ctx: AddonContext; location?: AddonRouteLocation }) {
  const { api } = ctx;
  const amfi = useAmfiCheck(api, location);
  // As of the last read: Wealthfolio keeps this page loaded while the user changes accounts elsewhere.
  const [allAccounts, setAllAccounts] = useState<Account[] | null>(null);
  const accounts = allAccounts?.filter((a) => a.isActive && !a.isArchived) ?? null;
  const [statement, setStatement] = useState<Statement | null>(null);
  const [fileName, setFileName] = useState("");
  // Bumped by Use another file, which clears the chosen file.
  const [resets, setResets] = useState(0);
  // What the last review ended with, such as "Finished: nothing … was saved."
  const [notice, setNotice] = useState("");
  // Summary and depository statements: their holdings, saved as snapshots.
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  // Bumped on every read, so a review starts afresh.
  const [reads, setReads] = useState(0);
  const detailed = statement && !holdings ? (statement as CasData) : null;
  // Closed schemes need no account or fund, so the review leaves them out, and uses each scheme's
  // readable name.
  const data = useMemo(() => detailed && withoutClosed(withReadableNames(detailed)), [detailed]);
  const [remembered, setRemembered] = useState<AccountChoices | null>(null);
  const [fundChoices, setFundChoices] = useState<Record<string, FundChoice | undefined>>({});
  // Storage requests can finish out of order; rereads must wait for these writes too.
  const choiceWrites = useRef(Promise.resolve());
  const [busy, setBusy] = useState<"" | "preview" | "import" | "check">("");

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

  const clear = () => {
    setStatement(null);
    setHoldings(null);
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
        throw new CasError("parse", `Couldn't load the accounts: ${String(e)}. Choose Read statement to try again.`);
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
    setAllAccounts(loaded);
    setFundChoices(funds);
    setRemembered(choices);
    setHoldings(held);
    setStatement(full);
    setFileName(name);
    setNotice("");
    setReads((n) => n + 1);
  };

  const chooseAccount = (key: string, id: string) => {
    setRemembered((choices) => ({ ...choices, [key]: id }));
    choiceWrites.current = choiceWrites.current
      .then(() => (id ? api.storage.set(key, id) : api.storage.delete(key)))
      .catch(() => api.toast.error("Couldn't remember the account."));
  };

  // Leaving a fund out forgets it for every folio that shares the key; the left-out state isn't saved.
  // `detailed` keeps a detailed import's choice beside a holdings import's asset priced from
  // statements: its choices change only the fund kept for detailed imports.
  const chooseFund = (key: string, choice: FundChoice, detailed = false) => {
    setFundChoices((choices) => ({ ...choices, [key]: choice }));
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

  // Accounts a save created join the ones read, so their remembered choices count.
  const created = (made: Account[]) => setAllAccounts((all) => all && [...all, ...made.filter((a) => !all.some((b) => b.id === a.id))]);

  const another = (said?: string) => {
    clear();
    setResets((n) => n + 1);
    setNotice(said ?? "");
    // A focus moved while the form returns stays where the user put it.
    setTimeout(() => {
      if (focusDropped()) document.getElementById("cas-file")?.focus();
    });
  };

  const reviewing = statement && remembered && accounts ? (holdings ? "holdings" : data ? "detailed" : null) : null;

  return (
    <Page>
      <PageHeader
        heading="CAS Importer (India)"
        text="Import a CAMS, KFintech, NSDL or CDSL statement (CAS PDF). The PDF is read on this device."
      />
      <PageContent>
        {/* A fieldset is as wide as its widest unbreakable content unless its minimum width is 0. */}
        <fieldset disabled={busy !== ""} className="min-w-0 space-y-6" style={{ minWidth: 0 }}>
          {/* While a statement is reviewed, its Questions say what AMFI would change. */}
          {!reviewing && <AmfiBanner amfi={amfi} />}
          {notice && !reviewing && <p className="text-muted-foreground text-sm">{notice}</p>}
          <div hidden={!!reviewing}>
            <StatementForm ctx={ctx} onClear={clear} onRead={read} disabled={busy !== ""} fileRef={amfi.next} reset={resets} />
          </div>
          {reviewing === "holdings" && (
            <HoldingsImport
              key={reads}
              ctx={ctx}
              statement={statement!}
              holdings={holdings!}
              fileName={fileName}
              accounts={accounts!}
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
              onCreated={created}
              onAnother={another}
            />
          )}
          {reviewing === "detailed" && (
            <DetailedImport
              key={reads}
              ctx={ctx}
              statement={detailed!}
              data={data!}
              fileName={fileName}
              accounts={accounts!}
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
                for (const [key, choice] of funds) chooseFund(key, choice, true);
              }}
              onCreated={created}
              onAnother={another}
            />
          )}
        </fieldset>
      </PageContent>
    </Page>
  );
}
