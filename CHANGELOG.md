# Changelog

All notable changes to the wealthfolio-cas-importer addon will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Import summary CAMS/KFintech statements and NSDL/CDSL depository statements as holdings snapshots: choose an account that tracks holdings for each folio or demat account, confirm each fund and share by its ISIN, and preview each account's snapshot. Holdings the statement doesn't list and cash carry over from the account's latest snapshot, except holdings an earlier import of the same folio or demat account added and the statement no longer lists; a folio's fund that an account tracking transactions already holds is left out by default; costs come from the statement, the account's average cost in INR, or what you type. A split recorded since the snapshot being carried over, and a holding priced by hand whose cost would replace its price, are flagged. Bonds and NPS holdings are left out for now

### Changed

### Deprecated

### Removed

### Fixed

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
