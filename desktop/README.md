# Cynode Desktop

This Electron shell loads the same Cynode web experience inside a persistent desktop session and can open unrestricted secondary browser windows through Electron-controlled IPC.

Installed builds default to the hosted Cynode app at `https://cynode.vercel.app/`, so ordinary users can install and launch Cynode Desktop directly from a desktop shortcut without running a local server.

## Run locally

1. Start the Cynode web app locally.
2. Run `npm run desktop:dev`.

In development, the desktop app defaults to `http://127.0.0.1:3001/`.

To point it at a deployed environment instead, set `CYNODE_DESKTOP_START_URL` before launching Electron.

## Build Installers

Run:

- `npm run desktop:dist:win`
- `npm run desktop:dist:mac`
- `npm run desktop:dist:linux`

The Windows build produces an NSIS installer that can create a Start Menu entry and a desktop shortcut for ordinary users.

## Deep-link launch from the browser

The desktop app registers `cynode://`.

Example:

`cynode://open?url=https%3A%2F%2Fexample.com&title=Example`

That lets the normal web app launch the installed desktop app with OS-level user consent and ask it to open a full secondary window.

## Sync model

The desktop app syncs with the web app through the same Cynode backend account and data model.

It does **not** automatically inherit cookies from Chrome, Edge, or Firefox. Users sign into Cynode Desktop with the same account, and their saved graphs, media, analytics, and other server-backed state stay in sync across web and desktop.

Once a user signs into Cynode Desktop, the Electron session is persisted across launches, so opening the installed app from its desktop icon brings them back into the same Cynode workspace without revisiting the browser first.
