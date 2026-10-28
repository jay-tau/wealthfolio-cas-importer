# Changelog

All notable changes to the wealthfolio-cas-importer addon will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Import summary CAMS/KFintech statements and NSDL/CDSL depository statements as holdings snapshots: choose an account that tracks holdings for each folio or demat account, confirm each fund and share by its ISIN, and preview each account's snapshot. Holdings the statement doesn't list and cash carry over from the account's latest snapshot, except holdings an earlier import of the same folio or demat account added and the statement no longer lists; a folio's fund that an account tracking transactions already holds is left out by default; costs come from the statement, the account's average cost in INR, or what you type. A split recorded since the snapshot being carried over is flagged
- Record a fund's cash as transfers from and to a bank account Wealthfolio tracks, chosen for each PAN or folio: purchases, redemptions and IDCW payouts come with a transfer pair Wealthfolio links instead of a deposit or withdrawal, while switches and mergers keep theirs. The preview offers a deposit or withdrawal the bank account already has, within 7 days and for the same amount, in place of a new transfer; if you tick it, the add-on changes it into a transfer and links it. Transactions imported earlier with a deposit or withdrawal count as already in Wealthfolio
- Import bonds and NPS holdings from NSDL/CDSL statements. Each is searched first; when no result fits, "Use the statement's prices" creates a Wealthfolio asset priced by hand: a bond by its ISIN, an NPS scheme by a symbol from its printed name, one per scheme however many PRANs hold it. Each PRAN gets its own account choice, like a folio or demat account. A bond's proposed cost is its face value times the number of bonds, after the account's average cost. The printed details stay on the asset's metadata (`casStatement`, and Wealthfolio's own bond fields it doesn't have yet), so a data source can take over its prices later. An existing asset Wealthfolio prices from market data stays so
- After saving a holdings snapshot, each holding priced by hand gets the statement's price on the statement's date instead of the average cost Wealthfolio's save writes there; a kept one gets the same price when another account's import lists it, or else its latest price on or before that date. A same-day quote's notes are kept. Prices are repaired even when a save fails after writing them, and any price or detail that couldn't be saved is listed

### Changed
- Ask for permission to add, change and link activities, and to read whether a transfer is linked, for using a bank account's rows
- Ask for permission to save quotes and read quote history, and to read and update asset details, for pricing holdings from statements and keeping their printed details

### Deprecated

### Removed

### Fixed
- Offer only accounts that track transactions for a detailed statement, since Wealthfolio doesn't update the holdings of an account that tracks holdings from its transactions; a PAN or folio account chosen before that tracks holdings is ignored, and its row says why to choose again

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
