# Changelog

All notable changes to the wealthfolio-cas-importer addon will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed
- Say in the market-data permission's purpose that fund searches also use the fund's name and what you type
- Build the same zip, byte for byte, from the same commit, so a release and its release candidate have the same SHA-256

### Deprecated

### Removed

### Fixed
- Leave out and warn about possible redemption reversals, such as Franklin Templeton's "Payment - Units Extinguished-Reversed", when exactly one earlier unpaired redemption has the opposite units and amount; a genuine new purchase can also match and needs review
- Warn about a row that changes the unit balance without listing any units, instead of skipping it, and say when units are added or removed without a payment, such as bonus units

### Security

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
