# wealthfolio-cas-importer

Import Indian CAS statements (CAMS/KFintech, NSDL/CDSL) into Wealthfolio

The add-on reads a Consolidated Account Statement (CAS) PDF with
[casparser](https://github.com/codereverser/casparser), running under
[Pyodide](https://pyodide.org) in a Worker inside Wealthfolio's add-on sandbox. The statement is
parsed on the device. A detailed statement from CAMS or KFintech is imported as transactions; a
summary statement from CAMS or KFintech, or a statement from NSDL or CDSL, the depositories, is
imported as holdings (see [Summary and depository statements](#summary-and-depository-statements)).

Detailed imports have been checked in Wealthfolio 3.11.0's desktop app on Linux and Windows;
they haven't been tried on macOS.

To import, pick the PDF and enter its password, choose a Wealthfolio account for each PAN (and,
if you like, a different one for a folio), and confirm the Wealthfolio fund for each scheme; the
add-on searches by the ISIN printed on the statement, and by the fund's name if the ISIN finds
nothing or none is printed. Name-search results can be other funds: pick one with the statement's
fund name, plan and option, or leave the fund out. Closed schemes, with no units at either end and
nothing to import, are skipped. The preview lists every activity with its
cash deposit or withdrawal, the rows left out and why, and anything Wealthfolio already has. After
the import, it compares each fund's units in Wealthfolio with the statement's closing balance.

Importing the same statement again, or an overlapping one, adds only what's new: the add-on compares
each row with the account's activities. Wealthfolio's own duplicate check misses the trades of a fund
that an earlier import created, because an add-on can't create the fund before importing the way
Wealthfolio's CSV import does. A fund whose statement starts with units needs those units in
Wealthfolio first, from an earlier statement or entered by hand.
The units check counts posted account history; splits or option expiry in that history need review.

## Summary and depository statements

casparser returns holdings for these statements, including depository statements with transaction
sections. The add-on saves the holdings as a snapshot, an account's holdings and cash on the
statement's date, in Wealthfolio accounts that track holdings.
Choose such an account for the whole statement, and a different one or "Leave out" for any folio or
demat account. Demat labels use their order on the statement and broker name, without account numbers.
Confirm the Wealthfolio fund or share for each holding: shares are searched by their
ISIN too, and a fund confirmed for a detailed statement is already confirmed here. Bonds and
National Pension System (NPS) holdings are left out for now; any that casparser returns are listed
as left out even before a preview. If no holdings account is offered, create one in Wealthfolio
and reopen the add-on.

Check each summary folio's funds against the PDF. On made-up CAMS and KFintech statements,
casparser 1.4.1 merges identical printed folio numbers from different AMCs under the first AMC,
without a warning. A folio whose funds' ISINs name more than one fund house, from such a merge or
from fund houses merging, is still imported, but what its imports add isn't shared with the same
folio's imports from depository statements.

Wealthfolio's snapshot is the account's whole state on its date, so the preview shows each
account's complete snapshot before anything is saved:

- It starts from the account's latest snapshot on or before the statement's date; calculated
  snapshots are ignored. The statement's holdings replace their own; the account's other holdings
  and its cash carry over. A holding that an earlier import of the same folio or demat account added on or before that snapshot's date,
  and that the statement no longer lists, defaults to removed. If the printed identifiers can't
  be compared, it stays with a note to check it. You can keep or remove each one, and include or
  leave out each holding.
- A holding carried over from an older snapshot whose asset has a split recorded since gets a
  note: its units predate the split, so correct them in Wealthfolio after saving, and its cost
  there isn't reused. Splits recorded in archived accounts are hidden from add-ons, so those go
  unnoticed.
- A folio's fund that an account tracking transactions already holds, most likely from a detailed
  statement, is left out by default so it isn't counted twice. Another account holding a fund or
  share gets a warning.
- The cost is the one printed on the statement. When none is available, the cost is the account's
  average cost in INR in Wealthfolio for the statement's units, or whatever you type in INR. An
  existing cost in another currency leaves the statement cost unknown with a note. A printed zero is
  treated as unknown. Left blank, it's unknown: Wealthfolio stores it as zero and counts the
  holding's whole value as gain.
- Replacing a snapshot Wealthfolio already has for that date needs your confirmation.
- A nonzero cost for a holding known to use manual prices blocks saving: Wealthfolio would also
  use its average cost as its price. Clear an editable cost, leave the holding out and remove any
  kept position for it, or change its pricing mode in Wealthfolio, reconfirm the fund or share if
  needed, and preview again.

The manual-price check uses the snapshot being carried over, returned portfolio holdings, pricing
information in search results, and the latest readable snapshot of each archived account when one
is available. Those archived snapshots supply pricing information only, not current overlap
warnings. SDK 3.11.0 can't list every existing asset: an asset absent from these results, including
one in an archived account with no readable snapshot, can have manual pricing that goes undetected.

Wealthfolio counts units added or removed between two snapshots as money put in or taken out, at
the later snapshot's prices.

## What the add-on keeps

- In Wealthfolio's add-on storage, which device sync copies to your other devices: the account
  chosen for each PAN or folio, keyed by a SHA-256 hash of the PAN or folio number, and the fund
  confirmed for each ISIN, or for the registrar and scheme code of a scheme with no ISIN. Leaving
  a fund out forgets the fund confirmed for it, in every folio that holds it; if Wealthfolio can't
  delete it, the add-on says so and it can come back. "Left out" itself isn't kept: the next read
  searches for the fund again.
- Also in add-on storage, for summary and depository statements: the account chosen for the
  statement and for each folio or demat account, keyed by a hash of the PAN, email address or investor
  name; the folio number and parsed AMC (summary) or ISIN issuer (depository); or the demat account's DP and
  client IDs. Summary and depository folio account overrides are separate.
- Dated records of which funds and shares each holdings import added, with both their ISIN and
  registrar scheme code when available, keyed by a hash of the folio or demat account and the
  Wealthfolio account. Hashed links join summary and depository records when an ISIN establishes
  the same folio number and issuer; learned links remain when a later summary omits the ISIN,
  but stop being used if it names more than one issuer.
  Importing an earlier date preserves the records for later dates.
- In Wealthfolio's secret store, only if you tick "Remember": the PDF password. It stays after the
  add-on is uninstalled until you choose "Forget the saved password".

These hashes keep PANs and folio numbers out of casual view; they don't make them secret.
PANs are few enough to brute-force.

Fund and share searches send the printed ISIN, the name from the statement when the ISIN finds
nothing or none is printed, or what you type, to Wealthfolio's market-data providers. The
PDF, its password and your PAN never leave Wealthfolio.

## Install

Download `wealthfolio-cas-importer-<version>.zip` from
[Releases](https://github.com/jay-tau/wealthfolio-cas-importer/releases). In Wealthfolio's desktop
app, 3.11.0 or newer, open **Settings** → **Add-ons**, choose **Install from File**, pick the zip
and allow the permissions it asks for.

Wealthfolio's web app can't install it from a file yet: its server turns away add-on zips over about
1.5 MiB, and this one is about 11 MB
([wealthfolio/wealthfolio#2306](https://github.com/wealthfolio/wealthfolio/issues/2306)).

Each release also carries the zip's SHA-256 (`sha256sum -c wealthfolio-cas-importer-<version>.zip.sha256`)
and a build provenance attestation:
`gh attestation verify wealthfolio-cas-importer-<version>.zip --repo jay-tau/wealthfolio-cas-importer`
checks that the zip was built from this repository.

## Development

```bash
pnpm install
pnpm runtime          # Pyodide and the pinned wheels (runtime.json, runtime-requirements.txt) into assets/runtime/
pnpm build
pnpm test             # casparser under Pyodide in Node, and the mapping to Wealthfolio activities and snapshots, on the made-up statements in tests/fixtures/
pnpm test:casparser   # casparser's own tests under Pyodide, fetched from its git tag for the bundled version
pnpm bundle           # dist/wealthfolio-cas-importer-<version>.zip, checked against Wealthfolio's package limits
```

The tests load the TypeScript sources directly, so they need Node 22.18 or newer.

`pnpm test:browser` runs the parser and the import page inside a copy of Wealthfolio's sandbox
(sandboxed iframe, the add-on content security policy) in Playwright's Chromium and Firefox, against a
fake host; pass `webkit` to add WebKit.
Install the browsers first with `pnpm exec playwright-core install chromium firefox`.

The statements in `tests/fixtures/` are made up. `make_cas.py` (detailed), `make_summary_cas.py`,
`make_nsdl_cas.py` and `make_cdsl_cas.py` write them (they need `reportlab` and `pikepdf`); their
password is `ABCDE1234F`. Never commit a real statement.

## Updating casparser and Pyodide

Renovate opens one pull request, "Python runtime", for new releases of Pyodide (`package.json`),
casparser and pypdfium2 (`runtime-requirements.txt`, pinned with hashes). The wheels Pyodide builds
itself, listed in `runtime.json`, follow its version. CI then:

- downloads every file and checks its hash, failing when a release has no wheel Pyodide can load;
- checks that casparser imports only what the add-on bundles, that the bundled wheels meet each
  other's requirements, and that the `casparser_isin` stub has every method casparser calls;
- parses the made-up statements, and runs casparser's own tests, under Pyodide in Node;
- builds the package and checks it against Wealthfolio's limits: 256 entries, 5 MiB per file and
  25 MiB in total;
- reads a statement in Chromium, Firefox and WebKit inside a copy of the add-on sandbox.

Every bump also needs `THIRD_PARTY_NOTICES.md` (and perhaps `licenses/`) brought up to date; the
tests fail until it names the new files. When casparser starts needing a package Pyodide builds,
add it to `runtime.json`.

## Releasing

Set the version in `manifest.json` and `package.json`, and move `CHANGELOG.md`'s `[Unreleased]`
entries into a `## [<version>] - YYYY-MM-DD` section. Pushing the tag `v<version>` then runs CI's
checks and publishes the zip CI built as a GitHub release, with its SHA-256, its build provenance
and that CHANGELOG section as the notes; a `v<version>-rc.N` tag makes a pre-release. The release
stops before CI if the tag, either version or the CHANGELOG doesn't match.

## License

MIT. The package also carries Pyodide, casparser and the other components listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
