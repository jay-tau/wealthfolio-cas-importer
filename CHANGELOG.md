# Changelog

All notable changes to the wealthfolio-cas-importer addon will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial addon structure and setup
- Read detailed CAMS/KFintech CAS PDFs with casparser under Pyodide, in a Worker, and show what they contain
- Turn a parsed statement into Wealthfolio import rows, each trade and IDCW payout with its cash deposit or withdrawal, and a warning for each row left out (not used by the page yet)

### Changed

### Deprecated

### Removed

### Fixed

### Security

## [1.0.0] - {{currentDate}}

### Added
- Initial release of wealthfolio-cas-importer addon
- Basic addon functionality and core features
- Integration with Wealthfolio addon SDK v3.11.0
- Sidebar navigation integration for easy access
- Responsive design for all screen sizes

### Features
- Import Indian mutual fund CAS statements (CAMS/KFintech) into Wealthfolio
- User-friendly interface
- Compatible with Wealthfolio platform

### Compatibility
- Requires Wealthfolio 3.11.0 or newer
