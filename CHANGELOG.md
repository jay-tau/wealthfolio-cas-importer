# Changelog

All notable changes to the wealthfolio-cas-importer addon will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Show each fund's plan (Direct or Regular) and option (Growth or IDCW) as badges beside its name on the statement, its search results and the confirmed fund, on the Funds and Holdings cards, to make names like "DIRECT PLAN GROWTH" and "Dir Gr" easier to compare. The add-on reads them from the end of each name; a result's or confirmed fund's badge is a warning when it differs from the statement's, and a name that doesn't give its plan or option has no badge for it
- Import `GIFT_IN` and `GIFT_OUT` as unit transfers at the gift day's NAV, with no cash. A gift received on its own starts its cost and holding period that day; a matched pair in two accounts carries the giver's recorded costs and purchase dates. The preview leaves out same-account pairs and unsafe or inconsistent rows, and flags likely earlier entries. See the README's Gifts section for pairing rules and the tax-cost distinction

### Changed
- Ask on the Funds card to check that each fund found matches the statement's name, plan and option, then choose Use this fund, which is needed only the first time. The "No AMFI result" paragraph repeated under each fund, which read as a problem with that fund, is now one note below the Funds or Holdings card's introduction, shown while a fund's search finds no AMFI result: it recommends AMFI for daily fund prices, added in Settings → Market data before confirming, and says to search each fund's ISIN or AMFI scheme code
- Read statements with pypdfium2 5.15.1, up from 5.14.0. It's built on PDFium 159.0.8149.0, up from 156.0.8076.0, which pypdfium2's release notes say fixes a few CVEs. 5.15.1 also fixes a rare error when closing a statement after reading it, if Python's garbage collector ran at the same time
- Read a statement PDF that has no password, such as one saved again from a PDF viewer, with the PDF password box left empty: Read statement needs only the file, and a note under the box says it can stay empty. Before, it stayed disabled until something was typed. A statement that has a password still says "Wrong password" when read without one. With Remember the password ticked, an empty password isn't saved, and a saved password stays as it is
- License the add-on under the GNU Affero General Public License, version 3 or any later version (AGPL-3.0-or-later), like Wealthfolio's AGPL-3.0, instead of the MIT License. Releases through 2.0.1 stay under the MIT License, and the components the package carries keep their own licences, listed in `THIRD_PARTY_NOTICES.md`

### Deprecated

### Removed

### Fixed
- Say when casparser couldn't read a statement's date or period, as soon as the statement is read: "casparser couldn't read this statement's date or period, so it can't be imported." casparser leaves the period empty when it doesn't recognise where a statement prints it. Before, a detailed statement was read anyway, and only after its accounts were chosen and every fund confirmed did each Preview the import fail with "Couldn't prepare the preview: Error: Not a statement date: ". A summary or depository statement showed "Couldn't read the statement" with only "Not a statement date: "
- Leave out a summary statement's line whose units × NAV don't give its value, to the paisa plus the units' and NAV's rounding, or that has units but no NAV, or a value but no units, and say it may have been misread and needs checking against the PDF. casparser 1.4.1 reads a cell it can't read as 0, and on made-up statements an amount of ₹1 crore or more without its leading digit, without a warning. Before, a cost of ₹1 crore or more could be saved without its leading digit, a fund whose units couldn't be read could be removed as if it had been sold, and one whose NAV couldn't be read got a price of ₹0. The holdings import now leaves that fund's holding in the folio's account as it is, with its units, cost, price and what earlier imports added, or doesn't add it, even from another folio's line; Check units marks it for review
- Don't count a holding twice in a holdings import when it's confirmed to another asset than the one an earlier import of its folio, demat account or PRAN added, such as AMFI's result after Yahoo's, or a summary statement's fund priced from statements that now prints its ISIN. The preview keeps the old asset and leaves the new one out, and the new one's row offers to replace the old asset with it, naming both. Imports record identifiers, not units, so when the old asset may also hold other units, or a possibly misread line holds it back, both rows say so and ask to correct its units in Wealthfolio if both are kept. Before, the old asset kept its old units and the new one got the statement's, so the account held the fund twice
- Never save a statement's price that isn't positive for a holding priced by hand, including a price another account's import supplies for a kept holding, which then gets back the price it had
- Use the singular for a count of one in the detailed import's preview and result, and in the line that describes a statement once it's read: "1 new transaction", "1 possible duplicate", "Import 1 activity", "Imported 1 of 1 activity", "skipped 1 as a duplicate and created 1 fund", "Linked 1 of 1 bank row you chose with its transaction", "1 folio, 1 scheme, 1 row" and "1 demat account, 1 folio, 1 holding". Before, these counts were always plural, as in "1 new transactions" and "Import 1 activities"
- Use the singular for a count of one in the warning for a merger left out because its other half can't be matched, as in "the folio has 1 merger sale and 0 merger purchases on this day". Before, it read "1 merger sales and 0 merger purchases"

### Security

## [2.0.1] - 2026-11-06

### Fixed
- Keep each "Already in Wealthfolio" badge in the detailed import's preview whole with Wealthfolio 3.12.0's Mono font, which its Classic theme picks, and Extra large text in its default 1440 × 960 window, by narrowing the preview's Status badges' padding. Before, after reading a statement again, the table was 2 px wider than the page, so it scrolled sideways and each badge's right end was cut off
- Let `pnpm bundle` run in a Windows checkout made with `core.autocrlf=true`, Git for Windows' default, and build the same zip there as on Linux. Before, its CRLF line endings stopped `pnpm runtime` at `runtime-requirements.txt`, and fixing only that built a different zip. A `.gitattributes` now checks text files out with LF line endings, `pnpm runtime` also reads CRLF ones, and CI builds the zip on Windows and checks that it matches Linux's

## [2.0.0] - 2026-11-05

### Added
- Preselect AMFI's result when the search for a fund's ISIN finds one, with AMFI added in Wealthfolio's Settings → Market data, so the fund is priced from AMFI's daily NAVs; confirm it as before. For a fund Wealthfolio already has, priced from Yahoo or from statements, AMFI's result isn't preselected, since picking it adds a second asset: the Funds card says so, and how to switch that asset to AMFI in Wealthfolio. Results and confirmed funds with AMFI selected say so
- Say on the Funds card when the search for a fund's ISIN, or for the name of one printed without it, finds no AMFI result: that Wealthfolio can price funds from AMFI once it's added in Settings → Market data, and what AMFI's search can't find

### Changed
- Checked with Wealthfolio 3.12.0: its Linux desktop app, both updated from 3.11.0 and new, and its web app, which can now install the add-on from its zip ([wealthfolio/wealthfolio#2306](https://github.com/wealthfolio/wealthfolio/issues/2306)). The README says which Wealthfolio version each platform was checked on, that the web app needs 3.12.0, and that Wealthfolio 3.12.0 classifies a new fund priced from statements as a mutual fund rather than common stock ([wealthfolio/wealthfolio#2359](https://github.com/wealthfolio/wealthfolio/issues/2359))
- Import a fund house's merger as a Wealthfolio fund conversion: the new fund's units keep the old units' cost and purchase dates, nothing is sold and no cash moves. Before, a merger was a sale and a purchase with a withdrawal and a deposit, so Wealthfolio could show a gain or loss that didn't happen, and the units' cost and purchase date restarted. A merger imported that way is listed as already in Wealthfolio; replacing it is up to you. If Wealthfolio has only part of it, or has the conversion changed since its import, the preview says so and leaves the merger out. Switches you asked for stay a sale and a purchase
- Require Wealthfolio 3.12.0 or newer, which records fund conversions. Update every device you sync before importing a merger

### Fixed
- Import the rows of a fund chosen from AMFI that Wealthfolio doesn't have yet. Wealthfolio 3.12.0's import check asks for an exchange for it, which AMFI's funds don't have, so the preview listed every trade as one Wealthfolio can't import; Wealthfolio's import itself creates the fund, priced from AMFI
- Let a statement be read again after its parser stops or Python hits a fatal error, without restarting Wealthfolio or turning the add-on off and on. Stop the parser if it hasn't started within 2 minutes or hasn't answered a read within 5 minutes, show an error and enable the form; the next read starts a new parser. Before, a parser that never answered left the form disabled, and the form kept reusing a broken parser
- Load Wealthfolio's accounts on each Read statement, so account choices, saved-account notes, previews and Check units use the current list. After adding an account, choose Read statement again
- Show the whole choice in the Accounts and Bank account selects and in the holdings import's Accounts select. Each select is as wide as its choice, at least 18rem (or the card's width if narrower) and at most the card's width; when the choice doesn't fit beside its label, the select moves under the label, and when it's wider than the card, it wraps onto more lines. An account name without spaces wraps within the word, in the select and in its list of choices. Before, each select was 18rem wide, so a longer choice was cut off, such as "Same as PAN (Outside Wealthfolio)" with Wealthfolio 3.12.0's Classic theme and Mono font, or a choice naming a long account, and in a narrow window a long account name without spaces ran past the edge of the list
- Keep every column of the detailed import's preview in view with Wealthfolio 3.12.0's Extra large text in its default 1440 × 960 window. Narrow the cells' horizontal padding; a Cash cell can wrap after its kind ("deposit" above the amount), and the bank account's name under it can wrap too. Before, the table was wider than the page, so the Status column, with the "Import anyway" boxes after reading a statement again, was out of view, and WebKitGTK shows no scrollbar until you scroll sideways. In Chromium-based browsers, the Status column is now also as wide as its badges, which used to run past it
- In Chromium-based browsers, keep Check units' Status column, and the snapshot preview's, as wide as their badges. Before, in a narrow window, Check units' "Needs review" badges ran past the column and were cut off at the table's edge

## [1.2.0] - 2026-11-01

### Changed
- Ask for permission to read Wealthfolio's settings, for its timezone when checking units
- Show the add-on as "CAS Importer (India)" in Wealthfolio's add-on list, the sidebar and the import page's heading, and set its manifest author to "jay-tau". Its ID stays `cas-importer`, so Wealthfolio still treats it as the same add-on

### Fixed
- Detailed imports find a fund's earlier activities and count its opening and closing units after its display code changes in Wealthfolio: they go by the fund's asset ID, or for a fund confirmed without one, by the symbol and exchange on each asset's profile. Before, a renamed fund's trades and reinvested dividends were offered as new and its units counted as zero, and another asset whose display code was the fund's symbol added its units to the fund's. A fund confirmed from an existing asset that was since deleted, or whose symbol, exchange or type changed, has to be confirmed again. If its type isn't set, set it in Wealthfolio first
- Holdings imports find the account's own holding of an asset, other accounts' holdings of it and its pricing mode after its display code changes in Wealthfolio: they go by the symbol and exchange on each holding's asset profile. Before, a renamed holding confirmed without an asset ID was planned as a new one next to the account's existing holding, without its average cost; a folio's fund that an account tracking transactions holds wasn't left out by default, so importing it counted it twice; and a renamed asset's pricing mode, or its ID after saving, could be missed, leaving its statement price or details unsaved. A profile that can't be read stops the preview
- Check units on summary and depository statements, and a detailed statement's opening and closing units, count each activity on its day in Wealthfolio's timezone setting, as Wealthfolio does, or in UTC if none is set or it is invalid. Wealthfolio saves an activity entered in its form at the time of day entered, so its UTC day can differ: before, one entered at 02:00 in India on the day after a statement's date counted towards it, and one entered at 21:00 in Toronto on that date didn't
- Search for a fund in a CDSL statement's mutual fund folios by its scheme name, and name a new asset priced from the statement the same way, instead of using the scheme code printed before the name ("FMCDG - Fictiva Midcap Fund - Direct Plan - Growth" searched for "FMCDG"). The asset's printed details keep the name as printed

## [1.1.0] - 2026-10-30

### Added
- Import summary CAMS/KFintech statements and NSDL/CDSL depository statements as holdings snapshots: choose an account that tracks holdings for each folio or demat account (one chosen before that no longer tracks holdings is ignored, and its row says why to choose again), confirm each fund and share by its ISIN, and preview each account's snapshot. Holdings the statement doesn't list and cash carry over from the account's latest snapshot, except holdings an earlier import of the same folio or demat account added and the statement no longer lists; a folio's fund that an account tracking transactions already holds is left out by default; costs come from the statement, the account's average cost in INR, or what you type. A split recorded since the snapshot being carried over is flagged
- Record a fund's cash as transfers from and to a bank account Wealthfolio tracks, chosen for each PAN or folio: purchases, redemptions and IDCW payouts come with a transfer pair Wealthfolio links instead of a deposit or withdrawal, while switches and mergers keep theirs. The preview offers a deposit or withdrawal the bank account already has, within 7 days and for the same amount, in place of a new transfer; if you tick it, the add-on changes it into a transfer and links it. Transactions imported earlier with a deposit or withdrawal count as already in Wealthfolio
- Import bonds and NPS holdings from NSDL/CDSL statements. Each is searched first; when no result fits, "Use the statement's prices" creates a Wealthfolio asset priced by hand: a bond by its ISIN, an NPS scheme by a symbol from its printed name, one per scheme however many PRANs hold it. Each PRAN gets its own account choice, like a folio or demat account. A bond's proposed cost is its face value times the number of bonds, after the account's average cost. The printed details stay on the asset's metadata (`casStatement`, and Wealthfolio's own bond fields it doesn't have yet), so a data source can take over its prices later. An existing asset Wealthfolio prices from market data stays so
- Price summary and depository statements' funds and shares from the statement when no search result fits, like bonds and NPS schemes: "Use the statement's prices" creates an INR asset priced by hand, with the printed ISIN as its symbol, or for a summary fund without one, its registrar and scheme code (`MF-KFINTECH-TONDG`). Its printed name, ISIN, registrar and scheme code stay on the asset's metadata, and later holdings imports reuse it. Detailed statements search for such a fund again instead
- Check a summary or depository statement against accounts that track transactions, without an account that tracks holdings and without saving anything: Check units compares each confirmed holding's units, summed over its folios, demat accounts and PRANs, with what those accounts' posted activities add up to on the statement's date, and lists it as Match, Differ or Needs review. A row is compared once you confirm its accounts hold the same units as the statement; a split or option expiry, no history up to that date, or activities that can't be read need review. Holdings printed with zero units are confirmed and checked too, but still never go in a snapshot
- After saving a holdings snapshot, each holding priced by hand gets the statement's price on the statement's date instead of the average cost Wealthfolio's save writes there; a kept one gets the same price when another account's import lists it, or else its latest price on or before that date. A same-day quote's notes are kept. Prices are repaired even when a save fails after writing them, and any price or detail that couldn't be saved is listed

### Changed
- Ask for permission to read accounts' holdings and snapshots and to save snapshots, for importing summary and depository statements as holdings snapshots
- Ask for permission to add, change and link activities, and to read whether a transfer is linked, for using a bank account's rows
- Ask for permission to save quotes and read quote history, and to read and update asset details, for pricing holdings from statements and keeping their printed details

### Fixed
- Leave out a detailed statement's fund whose rows don't add up to its printed closing balance, by more than casparser's 0.005 units, instead of importing the rows casparser read: the preview gives both figures and the difference, still says how to correct earlier imports of its reversed purchases, and can import the fund anyway
- Offer only accounts that track transactions for a detailed statement, since Wealthfolio doesn't update the holdings of an account that tracks holdings from its transactions; a PAN or folio account chosen before that tracks holdings is ignored, and its row says why to choose again
- Say why an account chosen before is ignored when it's hidden or archived in Wealthfolio, or no longer available, instead of ignoring it silently, even when no account tracks holdings. A folio, demat account or PRAN whose own account is ignored needs choosing again instead of going with the PAN's or statement's account, and so does the bank account of a folio whose own or PAN's bank account is ignored, instead of using the PAN's bank account or Outside Wealthfolio
- Let `pnpm bundle` run on Windows, where it stopped at `rm -rf dist` without `rm` on `PATH`

## [1.0.1] - 2026-10-28

### Changed
- Say in the market-data permission's purpose that fund searches also use the fund's name and what you type
- Build the same zip, byte for byte, from the same commit, so a release and its release candidate have the same SHA-256

### Fixed
- Leave out and warn about possible redemption reversals, such as Franklin Templeton's "Payment - Units Extinguished-Reversed", when exactly one earlier unpaired redemption has the opposite units and amount; a genuine new purchase can also match and needs review
- Warn about a row that changes the unit balance without listing any units, instead of skipping it, and say when units are added or removed without a payment, such as bonus units

## [1.0.0] - 2026-10-27

### Added
- Initial addon structure and setup
- Read detailed CAMS/KFintech CAS PDFs with casparser under Pyodide, in a Worker, and show what they contain
- Turn a parsed statement into Wealthfolio import rows, each trade and IDCW payout with its cash deposit or withdrawal, and a warning for each row left out
- Import a statement: choose an account for each PAN or folio and confirm each fund by its ISIN (both remembered, and a fund forgotten when you leave it out; closed schemes are skipped), preview every activity, skip what Wealthfolio already has, import, and compare each fund's units with the statement
- Remember the PDF password in Wealthfolio's secret store on request, and forget it
- Search by the fund's name when its ISIN finds nothing or none is printed, and warn that those results can be other funds

### Fixed
- Start the parser without Pyodide's CSP errors or depending on the CSP to block its classic Worker probes
