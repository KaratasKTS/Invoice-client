# Invoice client

Collects invoice PDFs from Gmail, files them in Google Drive and keeps a copy on this computer.
A local web page lets you fetch, browse and open the invoices, email a month to yourself or your
accountant, and remove archives.

```
browser page  ──►  local server (Node)  ──►  Apps Script web app
   web/              server/                    backend/
                     keeps the key,             Gmail → Drive, mail, remove
                     saves files to archives/
```

Invoices are filed by the date of their email:

```
<year>/Τιμολόγια_<month>_<year>/<sender>/<month>_<file>.pdf
```

The same layout is used in Drive and in the local `archives/` folder.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer. No packages to install.
- A file named `key` in this folder containing the API secret (the `API_SECRET` script property of the Apps Script). It is gitignored.

## Start

| System | Command |
| --- | --- |
| Linux, macOS, Windows with Git Bash | `./start.sh` |
| Windows (cmd or double-click) | `start.bat` |

The page opens at `http://127.0.0.1:4780/`. Add `--no-open` to start without opening the browser.
The server only listens on this computer.

Settings are in `config.json`:

| Key | Meaning |
| --- | --- |
| `url` | The Apps Script web app URL (ends in `/exec`) |
| `port` | Port of the local page. The next free port is used when it is taken |
| `archiveDir` | Where the invoices are saved, relative to this folder |

## Using the page

- **Fetch invoices**: pick one or more months, or the last 1–90 days. New invoices are saved to Drive and then to this computer. Tick "Also email me a zip" to get each month by email as well.
- **Sync from Drive**: downloads everything that is in Drive but not on this computer.
- **Folder tree**: click a month to see its files and actions, click a file to open it in the page. PDFs use the browser's built-in viewer.
- **Month actions**: email the folder (to you, your accountant or another address), download missing files, remove zip files, remove the archive from Drive, delete the local copy.

Removing from Drive moves items to the Drive trash, where they can be restored for 30 days.

## Deploying the backend

The backend is the Apps Script project in `backend/`. After changing it:

1. Open the project at [script.google.com](https://script.google.com).
2. Replace the contents of `Code` and `api` with `backend/Code.gs` and `backend/api.gs`. Delete any other old script files (for example `t_fetch`).
3. Add a script file named `Config` with the contents of your `backend/Config.gs`. That file is gitignored; `backend/Config.example.gs` shows the format.
4. **Deploy → Manage deployments → Edit → Version: New version → Deploy.** Editing the existing deployment keeps the URL.

The `API_SECRET` script property must match the `key` file. The Drive advanced service is no longer needed.

The client and the backend must be updated together: requests are signed over `ts.exec_type.body`, and a backend from before this change rejects them with "Invalid signature".

## Command-line client

`./invoiceManager.sh` offers the same backend actions as an interactive menu (needs `curl`, `jq` and `openssl`). It does not save files locally.

## Development

```
npm test                 # or: node --test
```

The tests run the real `backend/*.gs` code under Node against fake Gmail and Drive services (`dev/gas-shim.js`), and the local server end to end against that.

To try the page without touching your real mailbox:

```
node dev/mock-backend.js
INVOICE_URL=http://127.0.0.1:4790/exec INVOICE_KEY_FILE=dev/mock.key INVOICE_ARCHIVE_DIR=/tmp/invoice-demo ./start.sh
```

Environment variables: `INVOICE_URL`, `INVOICE_PORT`, `INVOICE_KEY_FILE`, `INVOICE_ARCHIVE_DIR`, `INVOICE_NO_OPEN=1`.
