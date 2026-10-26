# wealthfolio-cas-importer

Import Indian mutual fund CAS statements (CAMS/KFintech) into Wealthfolio

The add-on reads a detailed Consolidated Account Statement (CAS) PDF from CAMS or KFintech with
[casparser](https://github.com/codereverser/casparser), running under
[Pyodide](https://pyodide.org) in a Worker inside Wealthfolio's add-on sandbox. The statement is
parsed on the device. So far it only shows what the statement contains; importing is planned in
[#2](https://github.com/jay-tau/wealthfolio-cas-importer/issues/2).

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

`pnpm test:browser` runs the parser inside a copy of Wealthfolio's sandbox (sandboxed iframe, the
add-on content security policy) in Playwright's Chromium and Firefox; pass `webkit` to add WebKit.
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
