# wealthfolio-cas-importer

Import Indian CAS statements (CAMS/KFintech, NSDL/CDSL) into Wealthfolio

The add-on reads a Consolidated Account Statement (CAS) PDF with
[casparser](https://github.com/codereverser/casparser), running under
[Pyodide](https://pyodide.org) in a Worker inside Wealthfolio's add-on sandbox. The statement is
parsed on the device. A detailed statement from CAMS or KFintech is imported as transactions; a
summary statement from CAMS or KFintech, or a statement from NSDL or CDSL, the depositories, is
imported as holdings (see [Summary and depository statements](#summary-and-depository-statements)).

Detailed imports have been checked in Wealthfolio's desktop app on Linux (3.11.0 and 3.12.0) and
Windows (3.11.0), and in its web app (3.12.0, in Chromium); they haven't been tried on macOS.

To import, pick the PDF and enter its password, choose a Wealthfolio account that tracks
transactions for each PAN (and, if you like, a different one for a folio), and confirm the
Wealthfolio fund for each scheme; the
add-on searches by the ISIN printed on the statement, and by the fund's name if the ISIN finds
nothing or none is printed. Name-search results can be other funds: pick one with the statement's
fund name, plan and option, or leave the fund out. Badges beside the statement's name, each result
and the confirmed fund show the plan (Direct or Regular) and option (Growth or IDCW, which older
names call Dividend) that each name ends with, in spellings such as "Direct Plan - Growth" or
"Dir Gr". A result's or confirmed fund's badge is a warning when the statement's name gives a
different one. A name that doesn't give its plan or option has no badge for it, and no warning: the
add-on doesn't guess it. Closed schemes, with no units at either end and
nothing to import, are skipped. The preview lists every activity with its
cash deposit or withdrawal (or [bank transfer](#bank-account)), the rows left out and why, and anything Wealthfolio already has. After
the import, it compares each fund's units in Wealthfolio with the statement's closing balance.
A fund whose rows don't add up to its closing balance is left out unless you tick "Import this
fund anyway"; then check its rows against the PDF and add or correct the missing ones in
Wealthfolio after importing.

A purchase costs the statement's units × NAV plus stamp duty; a redemption pays units × NAV less
STT and TDS. casparser says some older CAMS and KFintech layouts print no NAV column. casparser
1.4.1 derives those NAVs as amount ÷ units, rounded to 4 places, without marking them; the add-on
uses them as printed. The price can differ from the fund's NAV for that day; for a fund priced by
hand, it also becomes the fund's price for that day. The add-on can't tell whether the amount used
to derive a NAV includes that day's charges, and treats it as before them.

Importing the same statement again, or an overlapping one, adds only what's new: the add-on compares
each row with the account's activities. Wealthfolio's own duplicate check can't count copies of a row
once a duplicate was imported with "Import anyway". Before Wealthfolio 3.12.0 it also missed the
trades of a fund that an earlier import created. A fund whose statement starts with units needs
those units in Wealthfolio first, from an earlier statement or entered by hand.
The units check counts posted account history, each activity on its day in Wealthfolio's timezone
setting (UTC if none is set); splits or option expiry in that history need review.
Activities show an asset's display code, which can be changed, so rows and units go by the fund's
asset ID, or for a fund confirmed without one, by the symbol and exchange on each asset's profile.
When several assets have that symbol and exchange, the preview asks you to choose one under Funds.
If a chosen asset was deleted or its symbol, exchange or type changed, confirm the fund again under Funds.
If its type isn't set, set it in Wealthfolio before confirming it again.

### AMFI prices

Wealthfolio can price Indian funds from AMFI, the Association of Mutual Funds in India, which
publishes each fund's daily NAV. It's off until you add it in **Settings** → **Market data**, and we
recommend adding it before your first import: a fund Wealthfolio already has, priced from Yahoo for
example, isn't switched to AMFI later without editing its asset in Wealthfolio (see below). Then the
search for a fund's ISIN, on detailed, summary and depository statements, finds AMFI's scheme as
well as Yahoo's listing, and the add-on preselects AMFI's; confirm it as any other result. AMFI
finds a fund only by its exact ISIN or AMFI scheme code, in its current list of schemes: some closed
or merged schemes aren't in it, and an ISIN listed under more than one scheme code finds nothing.
While the search for a fund's ISIN, or for the name of one printed without it, finds no AMFI result,
the Funds or Holdings card shows one note below its introduction: it recommends AMFI, says to add it
in **Settings** → **Market data** if it isn't on, and to enter each fund's ISIN or AMFI scheme code
in its search box and press **Search**.

A fund Wealthfolio already has, priced from Yahoo or from statements, isn't switched: the add-on
doesn't preselect AMFI's result for it, since picking that adds a second asset for the fund. To
price the asset Wealthfolio has from AMFI, edit it in Wealthfolio: under **Market data**, turn on
**Automatic updates** if it's priced by hand, then choose AMFI as the preferred provider and map
AMFI to the fund's ISIN or scheme code.

Wealthfolio 3.12.0's import check asks for an exchange for a fund chosen from AMFI that Wealthfolio
doesn't have yet, which AMFI's funds don't have, while its import creates the fund priced from AMFI.
The add-on leaves that one error out and offers the fund's rows as new.

### Bank account

If Wealthfolio also tracks the bank account a PAN's purchases are paid from, choose it under
**Bank account** (a folio can have a different one, or none). Each purchase then comes with a transfer
from that account to the funds' account, and each redemption or IDCW payout with a transfer back,
which Wealthfolio links, instead of a deposit or withdrawal. Switches keep their deposit and
withdrawal, since their money stays with the fund house; mergers, gifts and reinvested dividends have
no cash row.

If the bank account already has the debit or credit, from a bank statement import for example, the
preview offers to use it: a withdrawal or deposit (or a transfer not yet linked) within 7 days, for
the transaction's amount to the paisa, with or without its stamp duty, STT or TDS. Tick it, and the
add-on imports the trade, adds the funds' account's side of the transfer, changes the bank's
withdrawal or deposit into a transfer and links the two. Transactions imported earlier with a deposit
or withdrawal count as already in Wealthfolio, and the add-on leaves those rows as they are.

### Mergers

When a fund house merges one fund into another, the statement shows the units leaving one fund and
arriving in the other. The add-on matches the two rows within one folio on one day and imports them
as a Wealthfolio fund conversion: the new fund's units keep the old units' cost and purchase dates,
nothing is sold and no cash moves. Both rows go in together or not at all. If you leave either fund
out, Wealthfolio can't import either row, or the merger lists stamp duty or another charge, which a
conversion can't carry, the preview leaves out both and says why. A switch you asked for, such as
from a Regular to a Direct plan or from Growth to IDCW, is a sale and a purchase, and is imported as
one.

Update Wealthfolio to 3.12.0 or newer on every device you sync before importing a merger: 3.11
doesn't handle conversions. If a device received a conversion while still on 3.11, after updating
it open the affected account and choose **Recalculate History**.

Version 1.2.0 and earlier imported a merger as a sale and a purchase, with a withdrawal and a
deposit. The add-on finds those four rows and lists the merger as already in Wealthfolio. Replacing
them with a conversion is up to you: delete the four rows in Wealthfolio, then read the statement
again. If Wealthfolio has only some of them, the preview doesn't import the merger and says how to
correct it. A conversion changed in Wealthfolio after its import isn't imported again either; delete
it there to import it as the statement has it. If the statement prints no NAV for the merger, the
add-on can't fully compare it with an earlier import. Then a matching sale or purchase, or other
unmatched cash in the funds' account on that day, leaves the merger out, and the preview says to
check those rows in Wealthfolio.

If you moved a conversion to an account and then archived that account, unarchive it before
previewing that merger again. Wealthfolio hides archived activities from add-ons, but their groups
can still cause the whole import to fail.

### Gifts

A gift moves units from one investor's folio to another's without a sale. casparser marks the
statement's row as a gift when its description says so. The add-on imports it as a transfer of the
units at that day's NAV, with no cash:

- Units received from a folio this import doesn't include are an external transfer in. They cost
  their value on the day of the gift, and Wealthfolio counts their gains and holding period from
  that day. That's what the gift added to your portfolio, but not their cost for tax: the receiver
  takes over the giver's cost and purchase dates, which the statement doesn't show and a transfer
  can't carry.
- Units given to a folio this import doesn't include are an external transfer out. They leave at
  their cost in Wealthfolio, with no gain or loss.
- When the statement has both sides, the add-on pairs them by day, fund, opposite units and the same
  NAV, if at least one side names the other's folio and neither names a different one. In two
  Wealthfolio accounts, both go in together, and Wealthfolio links them: the receiving account keeps
  the costs and purchase dates Wealthfolio has for the giver's units. In one account the units don't
  move, so the preview leaves out both. If you leave one side's folio or fund out, the other side is
  a gift on its own.

Wealthfolio links a transfer in and a transfer out of the same day, symbol and value that are imported
together in two accounts, whatever else they say. So the preview leaves out a gift that could be
linked with any gift but its own other side, both sides when one can't be imported or their units
or NAV don't match, and a pair Wealthfolio has only one side of, or both sides but not linked to
each other. It also leaves out a gift with stamp duty or another charge on its day, which a transfer
can't carry, and one with no NAV. If Wealthfolio has a transfer, purchase or sale of the same units
in the same account and fund on that day at another price or with a comment, such as one entered by
hand, the preview leaves the gift out and names it. For both sides in one account it says when
Wealthfolio has such a row, which changed the units' cost and purchase dates.

## Summary and depository statements

casparser returns holdings for these statements, including depository statements with transaction
sections. The add-on saves the holdings as a snapshot, an account's holdings and cash on the
statement's date, in Wealthfolio accounts that track holdings.
Choose such an account for the whole statement, and a different one or "Leave out" for any folio,
demat account or National Pension System (NPS) account. Demat labels use their order on the statement and
broker name, without account numbers; an NPS account's label is its PRAN as printed, masked.
Confirm the Wealthfolio asset for each holding: shares and bonds are searched by their
ISIN too, and a fund confirmed for a detailed statement is already confirmed here. Funds have the
same plan and option badges as on the Funds card; shares, bonds and NPS schemes have none. If no holdings
account is offered, create one in Wealthfolio and choose Read statement again.

A holding that no search result fits, including when the search finds only other funds or shares,
can use the statement's prices instead. The add-on then creates an INR asset priced by hand, and the
next statement finds it again. Its price comes from the statements you import and the prices you
enter, not from market data:

- A fund or share has its ISIN as the symbol. A summary statement's fund without an ISIN goes by
  its registrar and scheme code: KFintech's `TONDG` is `MF-KFINTECH-TONDG`. A fund's type is sent
  as `MUTUALFUND`, which Wealthfolio stores as `EQUITY` like a share's. Wealthfolio 3.12.0 and newer
  classify the new asset as a mutual fund, with an asset class guessed from its name
  ([wealthfolio/wealthfolio#2408](https://github.com/wealthfolio/wealthfolio/issues/2408)); older
  versions file funds and shares alike under common stock. Check a fund's classifications on its
  asset page. Detailed statements don't preconfirm this choice: reading one searches for the fund again.
- A bond is a `BOND` asset with its ISIN as the symbol. Its cost defaults to the face value times
  the number of bonds when the statement prints a face value (NSDL demat accounts do); CDSL demat
  accounts on NSDL statements print a market price instead. casparser 1.4.1 returns no bonds for
  CDSL statements.
- An NPS scheme is one asset however many PRANs hold it; Tier I and Tier II are separate schemes.
  Statements print no scheme code, so its symbol comes from the printed name, without the words
  every scheme name repeats: "NPS TRUST- A/C SBI PENSION FUNDS PRIVATE LIMITED SCHEME E - TIER I" is
  `NPS-SBI-E-TIER-I`. Its name is the printed one. casparser 1.4.1 returns NPS holdings for CDSL
  statements only. An NPS account goes by its PRAN as printed (masked), or by the investor when
  none is printed.
- After saving, the add-on keeps the statement's details on the asset's metadata: as printed under
  `casStatement` (a fund's or share's name, ISIN, registrar and scheme code, as printed), and for a
  bond asset, the ISIN, maturity date, coupon rate, face value and
  coupon frequency Wealthfolio's bond fields don't have yet. A frequency Wealthfolio's bond pricer
  doesn't know, such as "On Maturity", stays only in the printed details. If you later switch the
  asset to market prices, a data source that knows the ISIN, scheme code or scheme has what it needs.
  A bond's or NPS scheme's asset found by search gets these details too; a fund's or share's doesn't.

Check each summary folio's funds against the PDF. On made-up CAMS and KFintech statements,
casparser 1.4.1 merges identical printed folio numbers from different AMCs under the first AMC,
without a warning. A folio whose funds' ISINs name more than one fund house, from such a merge or
from fund houses merging, is still imported, but what its imports add isn't shared with the same
folio's imports from depository statements.

Check units compares the statement with Wealthfolio accounts that track transactions (Not set
included), once each holding is confirmed or left out. It needs no account that tracks holdings,
and saves nothing. Each holding's printed units are summed over its folios, demat accounts and
PRANs, holdings printed with zero units included: those are confirmed for the check, but never go in
a snapshot. Against them go the units that the posted activities of accounts with any for its asset
by the statement's date add up to on that date, summed over those accounts. Each activity counts on its
day in Wealthfolio's timezone setting, or in UTC if none is set. A row shows Match or
Differ once you tick Same holdings, confirming that those accounts hold its units only for the
statement's folios, demat accounts and PRANs, and all of them. A difference can mean a purchase or
redemption that wasn't imported, bonus units or shares, a transfer, or shares from a demerger. A
holding with no such activities, one with a split or option expiry, which only Wealthfolio's
portfolio engine can count, and every holding when activities can't be read need review. Wealthfolio
doesn't show add-ons the activities of archived accounts, so those aren't compared. Activities show
an asset's display code, which can be changed, so a holding goes by its asset's ID, or for a choice
remembered without one, by the symbol and exchange on each asset's profile. For a choice without an
ID, several assets with that symbol and exchange, or an unreadable profile that could hide another
matching asset, need review.

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
- The cost is the one printed on the statement. Otherwise, the preview tries the account's average
  cost in INR for the statement's units, then a bond's face value times its units. You can change
  that proposed amount or leave it blank. An existing cost in another currency is not reused and
  gets a note. A printed zero is treated as unknown. Left blank, it's unknown: Wealthfolio stores
  it as zero and counts the holding's whole value as gain.
- Replacing a snapshot Wealthfolio already has for that date needs your confirmation.
- Saving a snapshot makes Wealthfolio write the average cost of each holding priced by hand as its
  price on the snapshot's date. Right after saving, the add-on writes the statement's price there
  instead for each such holding included from the statement. A kept holding uses that price too
  when another imported account includes it; otherwise it keeps its latest price on or before that
  date. If neither price is available, the preview warns that its average cost becomes its price.
  An existing quote on that date keeps its notes. A kept price also keeps the quote's other fields.
  If a snapshot fails after writing prices, the add-on still attempts price repair. Any price or
  detail it can't save is listed after the import.

Whether a holding is priced by hand comes from the snapshot being carried over, returned portfolio
holdings, pricing information in search results, and the latest readable snapshot of each archived
account when one is available. Those archived snapshots supply pricing information only, not
current overlap warnings. SDK 3.12.0 can't list every existing asset: an asset absent from these
results, including one in an archived account with no readable snapshot, can be priced by hand
without the add-on knowing, and then takes its average cost as its price on the snapshot's date.
For a statement-price or other manual-priced choice, the add-on also searches for its existing
asset and reads its profile. An existing market-priced asset keeps market pricing, even if no
account holds it. If that lookup fails for a choice that would use manual prices, the preview
stops. A known manually priced asset must also be found before saving, so its existing quote can
be kept. Holdings show an asset's display code, which can be changed, so the account's holdings and
other accounts' go by the symbol and exchange on each asset's profile, and the preview stops when a
profile can't be read. Try the preview again.

Wealthfolio counts units added or removed between two snapshots as money put in or taken out, at
the later snapshot's prices.

## What the add-on keeps

- In Wealthfolio's add-on storage, which device sync copies to your other devices: the account and
  bank account chosen for each PAN or folio, keyed by a SHA-256 hash of the PAN or folio number, and the fund
  confirmed for each ISIN, or for the registrar and scheme code of a scheme with no ISIN. Leaving
  a fund out forgets the fund confirmed for it, in every folio that holds it; if Wealthfolio can't
  delete it, the add-on says so and it can come back. "Left out" itself isn't kept: the next read
  searches for the fund again.
- Also in add-on storage, for summary and depository statements: the account chosen for the
  statement and for each folio, demat account or NPS account, keyed by a hash of the PAN, email address or investor
  name; the folio number and parsed AMC (summary) or ISIN issuer (depository); the demat account's DP and
  client IDs; or the PRAN as printed. Summary and depository folio account overrides are separate.
  The asset confirmed for a bond is kept under its ISIN, and for an NPS scheme under a hash of its symbol.
  A fund or share priced from statements is kept like any confirmed fund, but detailed imports don't preconfirm this choice.
- Dated records of which holdings each holdings import added, with both their ISIN and
  registrar scheme code when available, or an NPS scheme's symbol, keyed by a hash of the folio,
  demat account or PRAN and the Wealthfolio account. Hashed links join summary and depository records when an ISIN establishes
  the same folio number and issuer; learned links remain when a later summary omits the ISIN,
  but stop being used if it names more than one issuer.
  Importing an earlier date preserves the records for later dates.
- In Wealthfolio's secret store, only if you tick "Remember": the PDF password. It stays after the
  add-on is uninstalled until you choose "Forget the saved password".
- On the two activities of each merger's conversion, the group ID that pairs them: a SHA-256 hash of
  the Wealthfolio account, the folio number, the merger's date and the confirmed funds' symbols and
  exchanges. It stays the same when another statement omits an ISIN or prints different scheme codes.

These hashes keep PANs and folio numbers out of casual view; they don't make them secret.
PANs are few enough to brute-force.

Searches send the printed ISIN, the name from the statement when the ISIN finds
nothing or none is printed, or what you type, to Wealthfolio's market-data providers. The
PDF, its password and your PAN never leave Wealthfolio.

## Install

Download `wealthfolio-cas-importer-<version>.zip` from
[Releases](https://github.com/jay-tau/wealthfolio-cas-importer/releases). In Wealthfolio's desktop
app or its web app, 3.12.0 or newer, open **Settings** → **Add-ons**, choose **Install from file**,
pick the zip and allow the permissions it asks for.

The web app needs 3.12.0: older servers turn away add-on zips over about 1.5 MiB, and this one is
about 11 MB ([wealthfolio/wealthfolio#2306](https://github.com/wealthfolio/wealthfolio/issues/2306)).

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

Copyright (c) 2026 jay-tau

This add-on is free software: you can redistribute it and/or modify it under the terms of the GNU
Affero General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. It is distributed in the hope that it will be
useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.

If you modify the add-on and let users interact with it remotely over a network, prominently offer
them that version's corresponding source at no charge (AGPL §13).

Releases through v2.0.1 were released under the MIT License.

The package also carries Pyodide, casparser and the other components listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), each under its own licence.
