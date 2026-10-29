# Changelog

All notable changes to the wealthfolio-cas-importer addon will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Import summary CAMS/KFintech statements and NSDL/CDSL depository statements as holdings snapshots: choose an account that tracks holdings for each folio or demat account (one chosen before that no longer tracks holdings is ignored, and its row says why to choose again), confirm each fund and share by its ISIN, and preview each account's snapshot. Holdings the statement doesn't list and cash carry over from the account's latest snapshot, except holdings an earlier import of the same folio or demat account added and the statement no longer lists; a folio's fund that an account tracking transactions already holds is left out by default; costs come from the statement, the account's average cost in INR, or what you type. A split recorded since the snapshot being carried over is flagged
- Record a fund's cash as transfers from and to a bank account Wealthfolio tracks, chosen for each PAN or folio: purchases, redemptions and IDCW payouts come with a transfer pair Wealthfolio links instead of a deposit or withdrawal, while switches and mergers keep theirs. The preview offers a deposit or withdrawal the bank account already has, within 7 days and for the same amount, in place of a new transfer; if you tick it, the add-on changes it into a transfer and links it. Transactions imported earlier with a deposit or withdrawal count as already in Wealthfolio
- Import bonds and NPS holdings from NSDL/CDSL statements. Each is searched first; when no result fits, "Use the statement's prices" creates a Wealthfolio asset priced by hand: a bond by its ISIN, an NPS scheme by a symbol from its printed name, one per scheme however many PRANs hold it. Each PRAN gets its own account choice, like a folio or demat account. A bond's proposed cost is its face value times the number of bonds, after the account's average cost. The printed details stay on the asset's metadata (`casStatement`, and Wealthfolio's own bond fields it doesn't have yet), so a data source can take over its prices later. An existing asset Wealthfolio prices from market data stays so
- Price summary and depository statements' funds and shares from the statement when no search result fits, like bonds and NPS schemes: "Use the statement's prices" creates an INR asset priced by hand, with the printed ISIN as its symbol, or for a summary fund without one, its registrar and scheme code (`MF-KFINTECH-TONDG`). Its printed name, ISIN, registrar and scheme code stay on the asset's metadata, and later holdings imports reuse it. Detailed statements search for such a fund again instead
- Check a summary or depository statement against accounts that track transactions, without an account that tracks holdings and without saving anything: Check units compares each confirmed holding's units, summed over its folios, demat accounts and PRANs, with what those accounts' posted activities add up to on the statement's date, and lists it as Match, Differ or Needs review. A row is compared once you confirm its accounts hold the same units as the statement; a split or option expiry, no history up to that date, or activities that can't be read need review. Holdings printed with zero units are confirmed and checked too, but still never go in a snapshot
- After saving a holdings snapshot, each holding priced by hand gets the statement's price on the statement's date instead of the average cost Wealthfolio's save writes there; a kept one gets the same price when another account's import lists it, or else its latest price on or before that date. A same-day quote's notes are kept. Prices are repaired even when a save fails after writing them, and any price or detail that couldn't be saved is listed

### Changed
- Ask for permission to add, change and link activities, and to read whether a transfer is linked, for using a bank account's rows
- Ask for permission to save quotes and read quote history, and to read and update asset details, for pricing holdings from statements and keeping their printed details

### Deprecated

### Removed

### Fixed
- Leave out a detailed statement's fund whose rows don't add up to its printed closing balance, by more than casparser's 0.005 units, instead of importing the rows casparser read: the preview gives both figures and the difference, still says how to correct earlier imports of its reversed purchases, and can import the fund anyway
- Offer only accounts that track transactions for a detailed statement, since Wealthfolio doesn't update the holdings of an account that tracks holdings from its transactions; a PAN or folio account chosen before that tracks holdings is ignored, and its row says why to choose again
- Say why an account chosen before is ignored when it's hidden or archived in Wealthfolio, or no longer available, instead of ignoring it silently, even when no account tracks holdings. A folio, demat account or PRAN whose own account is ignored needs choosing again instead of going with the PAN's or statement's account, and so does the bank account of a folio whose own or PAN's bank account is ignored, instead of using the PAN's bank account or Outside Wealthfolio

### Security

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
