# wealthfolio-cas-importer

Import Indian mutual fund CAS statements (CAMS/KFintech) into Wealthfolio

The add-on reads a detailed Consolidated Account Statement (CAS) PDF from CAMS or KFintech with
[casparser](https://github.com/codereverser/casparser), running under
[Pyodide](https://pyodide.org) in a Worker inside Wealthfolio's add-on sandbox. The statement is
parsed on the device.

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

What the add-on keeps:

- In Wealthfolio's add-on storage, which device sync copies to your other devices: the account
  chosen for each PAN or folio, keyed by a SHA-256 hash of the PAN or folio number, and the fund
  confirmed for each ISIN, or for the registrar and scheme code of a scheme with no ISIN.
- In Wealthfolio's secret store, only if you tick "Remember": the PDF password. It stays after the
  add-on is uninstalled until you choose "Forget the saved password".

These hashes keep PANs and folio numbers out of casual view; they don't make them secret.
PANs are few enough to brute-force.

Fund searches send the printed ISIN, the fund's name from the statement when the ISIN finds nothing
or none is printed, or what you type, to Wealthfolio's market-data providers. The
PDF, its password and your PAN never leave Wealthfolio.

## Development

```bash
pnpm install
pnpm runtime          # Pyodide and the pinned wheels (runtime.json, runtime-requirements.txt) into assets/runtime/
pnpm build
pnpm test             # casparser under Pyodide in Node, and the mapping to Wealthfolio activities, on the made-up statements in tests/fixtures/
pnpm test:casparser   # casparser's own tests under Pyodide, fetched from its git tag for the bundled version
pnpm bundle           # dist/wealthfolio-cas-importer-<version>.zip, checked against Wealthfolio's package limits
```

The tests load the TypeScript sources directly, so they need Node 22.18 or newer.

`pnpm test:browser` runs the parser and the import page inside a copy of Wealthfolio's sandbox
(sandboxed iframe, the add-on content security policy) in Playwright's Chromium and Firefox, against a
fake host; pass `webkit` to add WebKit.
Install the browsers first with `pnpm exec playwright-core install chromium firefox`.

The statements in `tests/fixtures/` are made up. `make_cas.py` writes them (it needs `reportlab`
and `pikepdf`); their password is `ABCDE1234F`. Never commit a real statement.

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

## License

MIT. The package also carries Pyodide, casparser and the other components listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
