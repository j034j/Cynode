# Cynode Desktop

This Electron shell loads the same Cynode web experience inside a persistent desktop session and can open unrestricted secondary browser windows through Electron-controlled IPC.

## Run locally

1. Start the Cynode web app locally.
2. Run `npm run desktop:dev`.

The desktop app defaults to `http://127.0.0.1:3000/`.

To point it at a deployed environment instead, set `CYNODE_DESKTOP_START_URL` before launching Electron.

## Deep-link launch from the browser

The desktop app registers `cynode://`.

Example:

`cynode://open?url=https%3A%2F%2Fexample.com&title=Example`

That lets the normal web app launch the installed desktop app with OS-level user consent and ask it to open a full secondary window.

## Sync model

The desktop app syncs with the web app through the same Cynode backend account and data model.

It does **not** automatically inherit cookies from Chrome, Edge, or Firefox. Users sign into Cynode Desktop with the same account, and their saved graphs, media, analytics, and other server-backed state stay in sync across web and desktop.
