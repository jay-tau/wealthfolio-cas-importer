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
pnpm runtime   # Pyodide and the pinned wheels (runtime.json) into assets/runtime/
pnpm build
pnpm test      # casparser under Pyodide in Node, and the mapping to Wealthfolio activities, on the made-up statements in tests/fixtures/
pnpm bundle    # dist/wealthfolio-cas-importer-<version>.zip
```

The tests load the TypeScript sources directly, so they need Node 22.18 or newer.

`pnpm test:browser` runs the parser inside a copy of Wealthfolio's sandbox (sandboxed iframe, the
add-on content security policy) in Playwright's Chromium and Firefox; pass `webkit` to add WebKit.
Install the browsers first with `pnpm exec playwright-core install chromium firefox`.

The statements in `tests/fixtures/` are made up. `make_cas.py` writes them (it needs `reportlab`
and `pikepdf`); their password is `ABCDE1234F`. Never commit a real statement.

## License

MIT. The package also carries Pyodide, casparser and the other components listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
