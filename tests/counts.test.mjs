// Counts of one read in the singular, and other counts in the plural, in the detailed import's
// preview and result and in both statement lines. Renders the components with Vite's SSR loader
// and made-up data.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { plural } from "../src/lib/plural.ts";

let server;
let components;
before(async () => {
  server = await createServer({
    configFile: false,
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  components = {
    ...(await server.ssrLoadModule("/src/components/preview.tsx")),
    ...(await server.ssrLoadModule("/src/pages/import-page.tsx")),
    ...(await server.ssrLoadModule("/src/pages/holdings-import.tsx")),
  };
});
after(() => server?.close());

/** The rendered text, with one space for each tag and run of spaces. */
const text = (name, props) =>
  renderToStaticMarkup(createElement(components[name], props))
    .replaceAll("<!-- -->", "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replaceAll("&#x27;", "'");

test("plural keeps a count of one singular", () => {
  assert.equal(plural(0, "folio"), "0 folios");
  assert.equal(plural(1, "folio"), "1 folio");
  assert.equal(plural(2, "folio"), "2 folios");
  assert.equal(plural(1, "activity", "activities"), "1 activity");
  assert.equal(plural(2, "activity", "activities"), "2 activities");
});

test("the preview counts transactions and activities", () => {
  const transaction = (status) => ({
    status,
    rows: [],
    transaction: {
      scheme: "Made-up Flexi Cap Fund",
      activity: { date: "2024-01-01", activityType: "BUY", quantity: "10", unitPrice: "10", amount: "100" },
      rows: [],
    },
  });
  const preview = (statuses, rowCount) =>
    text("Preview", {
      mapping: { warnings: [] },
      plan: statuses.map(transaction),
      importAnyway: new Set(),
      onImportAnyway() {},
      onImportUnbalanced() {},
      onImport() {},
      importing: false,
      rowCount,
      matches: new Map(),
      reuse: new Set(),
      onReuse() {},
      accounts: [],
    });
  const one = preview(["new", "duplicate"], 1);
  assert.match(one, / 1 new transaction, 0 already in Wealthfolio, 1 possible duplicate and 0 Wealthfolio can't import\. /);
  assert.match(one, / Import 1 activity $/);
  const two = preview(["new", "new", "duplicate", "duplicate"], 2);
  assert.match(two, / 2 new transactions, 0 already in Wealthfolio, 2 possible duplicates and 0 Wealthfolio can't import\. /);
  assert.match(two, / Import 2 activities $/);
});

test("the import result counts activities, duplicates, funds and bank rows", () => {
  const link = (id) => ({ transaction: {}, bankRow: { id } });
  const result = (summary, links) =>
    text("ImportResult", { result: { activities: [], summary: { success: true, ...summary } }, sent: [], closing: [], links });
  const one = result({ total: 1, imported: 1, duplicates: 0, assetsCreated: 1 }, [link("bank-1")]);
  assert.match(one, / Imported 1 of 1 activity Wealthfolio skipped 0 as duplicates and created 1 fund\. /);
  assert.match(one, / Linked 1 of 1 bank row you chose with its transaction\. /);
  const some = result({ total: 2, imported: 1, duplicates: 1, assetsCreated: 0 }, [link("bank-1"), link("bank-2")]);
  assert.match(some, / Imported 1 of 2 activities Wealthfolio skipped 1 as a duplicate and created 0 funds\. /);
  assert.match(some, / Linked 2 of 2 bank rows you chose with their transactions\. /);
  const two = result({ total: 4, imported: 2, duplicates: 2, assetsCreated: 2 }, []);
  assert.match(two, / Imported 2 of 4 activities Wealthfolio skipped 2 as duplicates and created 2 funds\. /);
});

test("the detailed statement line counts folios, schemes, rows and closed schemes", () => {
  const row = { date: "01-Jan-2024", description: "Purchase", amount: "100", units: "10", nav: "10", balance: "10", type: "PURCHASE", dividend_rate: null, gift_folio: null };
  // A closed scheme has no units and no rows.
  const scheme = (rows) => ({ scheme: "Made-up Fund", open: rows ? "10" : "0", close: rows ? "10" : "0", transactions: Array(rows).fill(row) });
  const line = (...folios) =>
    text("StatementSummary", {
      data: {
        file_type: "CAMS",
        investor_info: { name: "A MADE-UP INVESTOR" },
        statement_period: { from: "01-Apr-2023", to: "31-Mar-2024" },
        folios: folios.map((schemes) => ({ schemes })),
        parse_warnings: [],
      },
    }).trim();
  const start = "CAMS detailed statement for A MADE-UP INVESTOR, 01-Apr-2023 to 31-Mar-2024:";
  const skipping = "with no units and nothing to import.";
  assert.equal(line([scheme(1)]), `${start} 1 folio, 1 scheme, 1 row.`);
  assert.equal(line([scheme(2), scheme(0)]), `${start} 1 folio, 2 schemes, 2 rows. Skipping 1 closed scheme, ${skipping}`);
  assert.equal(line([scheme(1)], [scheme(0), scheme(0)]), `${start} 2 folios, 3 schemes, 1 row. Skipping 2 closed schemes, ${skipping}`);
});

test("the holdings statement line counts demat accounts, folios, NPS accounts and holdings", () => {
  const source = (kind, holdings) => ({ kind, holdings: Array(holdings).fill({}) });
  const line = (...sources) =>
    text("HoldingsSummary", {
      statement: { file_type: "NSDL", investor_info: { name: "A MADE-UP INVESTOR" }, statement_period: { to: "31-Mar-2025" }, parse_warnings: [] },
      holdings: { sources },
    }).trim();
  const start = "NSDL statement for A MADE-UP INVESTOR, as on 31-Mar-2025:";
  assert.equal(line(source("demat", 1), source("folio", 0), source("nps", 0)), `${start} 1 demat account, 1 folio, 1 NPS account, 1 holding.`);
  assert.equal(
    line(source("demat", 1), source("demat", 1), source("folio", 0), source("folio", 0), source("nps", 0), source("nps", 0)),
    `${start} 2 demat accounts, 2 folios, 2 NPS accounts, 2 holdings.`,
  );
  assert.equal(line(source("folio", 0)), `${start} 1 folio, 0 holdings.`);
});
