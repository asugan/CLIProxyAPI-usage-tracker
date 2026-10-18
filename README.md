# CLIProxyAPI Usage Monitor

A lightweight desktop dashboard for monitoring local CLIProxyAPI usage. It collects usage events from the CLIProxyAPI management endpoints, stores them locally, and turns token consumption into clear summaries by model, provider, source, and day.

## Features

- Local Electron app with a clean usage dashboard
- Manual or automatic polling from the CLIProxyAPI usage queue
- Token totals for input, output, reasoning, cached, and overall usage
- Breakdowns by model, provider, source/account, and day
- Recent request table with status and cache ratio
- API key usage and log viewer panels
- Local SQLite storage with automatic migration from the legacy JSON store
- System tray support for background monitoring

## Requirements

- Node.js with Electron-compatible runtime support
- A running CLIProxyAPI instance
- CLIProxyAPI management key

## Installation

```bash
npm install
```

## Usage

Start the app:

```bash
npm start
```

Then configure:

1. **CLIProxyAPI URL**: defaults to `http://127.0.0.1:8317`
2. **Management Key**: your CLIProxyAPI management key
3. **Polling interval**: how often usage should be collected when auto-polling is enabled
4. **Auto collect**: enable background polling, or use **Collect Now** for manual collection

The app only stores usage data locally and does not modify CLIProxyAPI usage records.

## Data Storage

Usage events and settings are stored under Electron's application data directory for this app. Usage records are kept in a local SQLite database and capped to the latest 50,000 events.

## Development

Run syntax checks:

```bash
npm run check
```

Run the app locally:

```bash
npm start
```

## Project Structure

```text
assets/          App and tray icons
src/main.js      Electron main process, polling, storage, and IPC handlers
src/preload.js   Secure renderer bridge
src/renderer.js  Dashboard rendering and UI actions
src/index.html   Application shell
src/styles.css   Dashboard styles
```

## GNOME Top Panel Extension

For a native Ubuntu 24.04 / GNOME 46 quota indicator, see [gnome-extension/README.md](gnome-extension/README.md). It independently reads Claude/Codex OAuth quotas through CLIProxyAPI v8, stores its management key in GNOME Keyring, and does not consume the usage queue.
