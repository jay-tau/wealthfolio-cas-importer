# wealthfolio-cas-importer

Import Indian mutual fund CAS statements (CAMS/KFintech) into Wealthfolio

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev:server

# Build for production
npm run build

# Package addon
npm run bundle
```

Wealthfolio 3.7 indexes private files below `assets/` and `dist/assets/` automatically. Use
`ctx.assets.getBlob(path)` or `ctx.assets.getUrl(path)` to load them in the sandbox; no manifest
asset list or permission is required. Blob URLs are valid only for the current addon lifetime.

The generated Vite config targets Chrome/Edge 107, Firefox 104, and Safari 16, matching Wealthfolio
3.7. The sandbox supports packaged images, fonts, media, CSS, and WebAssembly. Worker/service-worker
entry points, popups, direct network requests, and remote CSS imports are intentionally unavailable.

## Features

- Add your features here

## License

MIT
