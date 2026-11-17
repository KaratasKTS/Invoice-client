'use strict';
// Local web server for the invoice client. It serves the page, keeps the API
// key away from the browser, talks to the Apps Script backend and stores the
// invoices on disk. It listens on this computer only.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { Settings, SettingsError, ROOT_DIR } = require('./config.js');
const { createBackend, BackendError } = require('./backend.js');
const { Store } = require('./store.js');
const { Jobs, JobBusyError } = require('./jobs.js');
const { createOperations, InputError } = require('./operations.js');

const MAX_BODY_BYTES = 1024 * 1024;
const PORT_ATTEMPTS = 20;

const STATIC_FILES = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const FILE_TYPES = {
  pdf: 'application/pdf',
  text: 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

const PAGE_CSP = "default-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      reject(new HttpError(415, 'Το αίτημα δεν είναι έγκυρο.'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Το αίτημα είναι πολύ μεγάλο.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
        resolve(data);
      } catch (err) {
        reject(new HttpError(400, 'Το αίτημα δεν είναι έγκυρο.'));
      }
    });
    req.on('error', reject);
  });
}

function tokensMatch(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Builds the app. Returns { listen(), close(), token, settings, store, jobs }.
 * options (used by the tests): configFile, archiveDir, port.
 */
function createApp(options = {}) {
  const settings = new Settings({ file: options.configFile });
  const archiveDir = options.archiveDir || settings.archiveDir;
  const webDir = path.join(ROOT_DIR, 'web');
  const wantedPort = options.port !== undefined ? options.port : settings.port;

  const token = crypto.randomBytes(24).toString('hex');
  const store = new Store(archiveDir);
  const backend = createBackend({ getUrl: () => settings.url, getKey: () => settings.key });
  const operations = createOperations({ backend, store, settings });
  const jobs = new Jobs();
  let port = wantedPort;

  function send(res, status, headers, body) {
    res.writeHead(status, {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  }

  function sendJson(res, status, data) {
    send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(data));
  }

  function servePage(res) {
    const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8').replace('__SESSION_TOKEN__', token);
    send(res, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP }, html);
  }

  function serveStatic(res, pathname) {
    const [file, type] = STATIC_FILES[pathname];
    send(res, 200, { 'Content-Type': type }, fs.readFileSync(path.join(webDir, file)));
  }

  /** Sends a file of the archive so the page can show it in its viewer. */
  function serveArchiveFile(req, res, url) {
    let rel;
    try {
      rel = decodeURIComponent(url.pathname.slice('/files/'.length));
    } catch (err) {
      throw new HttpError(400, 'Bad path');
    }

    const abs = store.resolveFile(rel);
    if (!abs) throw new HttpError(404, 'Το αρχείο δεν βρέθηκε.');

    const kind = Store.kindOf(abs);
    const type = FILE_TYPES[kind] || FILE_TYPES[path.extname(abs).toLowerCase()];
    const download = url.searchParams.get('download') === '1' || !type;
    const name = encodeURIComponent(path.basename(abs));
    const stat = fs.statSync(abs);

    res.writeHead(200, {
      'Content-Type': download ? 'application/octet-stream' : type,
      'Content-Length': stat.size,
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`,
      'Content-Security-Policy': "frame-ancestors 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
  }

  function startJob(type, title, run) {
    const job = jobs.start(type, title, run);
    return { job: Jobs.view(job) };
  }

  function appState() {
    const view = settings.publicView();
    return {
      hasKey: view.hasKey,
      hasUrl: !!view.url,
      accountantEmail: view.accountantEmail,
      archiveDir: store.rootDir,
      runningJob: jobs.running ? jobs.running.id : null,
    };
  }

  /** POST /api/jobs/<id>/cancel and /api/jobs/<id>/discard */
  function handleJobAction(res, url) {
    const [id, action] = url.pathname.slice('/api/jobs/'.length).split('/');
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, 'Η ενέργεια δεν βρέθηκε.');

    if (action === 'cancel') {
      jobs.cancel(id);
      return sendJson(res, 200, { job: Jobs.view(job) });
    }

    if (action === 'discard') {
      // Deletes the files this run saved to disk. Drive is not touched.
      if (job.status === 'running') throw new HttpError(409, 'Η ενέργεια εκτελείται ακόμα.');
      const removed = store.removeFiles(job.downloaded);
      job.downloaded = [];
      return sendJson(res, 200, { removed });
    }

    throw new HttpError(404, 'Not found');
  }

  async function handleApi(req, res, url) {
    if (!tokensMatch(req.headers['x-session-token'], token)) throw new HttpError(403, 'Η σελίδα έχει λήξει. Κάνε ανανέωση (F5).');

    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'GET') {
      if (route === 'GET /api/state') return sendJson(res, 200, appState());
      if (route === 'GET /api/settings') return sendJson(res, 200, { settings: settings.publicView() });
      if (route === 'GET /api/tree') return sendJson(res, 200, { tree: store.tree() });
      if (route === 'GET /api/remote') return sendJson(res, 200, { structure: await operations.remoteStructure() });
      if (url.pathname.startsWith('/api/jobs/')) {
        const job = jobs.get(url.pathname.slice('/api/jobs/'.length));
        if (!job) throw new HttpError(404, 'Η ενέργεια δεν βρέθηκε.');
        return sendJson(res, 200, { job: Jobs.view(job) });
      }
      throw new HttpError(404, 'Not found');
    }

    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');

    const body = await readJsonBody(req);

    if (url.pathname.startsWith('/api/jobs/')) return handleJobAction(res, url);

    switch (route) {
      case 'POST /api/settings':
        return sendJson(res, 200, { settings: settings.update({ url: body.url, accountantEmail: body.accountantEmail, key: body.key }) });
      case 'POST /api/settings/test':
        return sendJson(res, 200, { result: await operations.testConnection() });
      case 'POST /api/fetch':
        return sendJson(res, 202, startJob('fetch', 'Έλεγχος για νέα τιμολόγια', (ctx) => operations.fetchInvoices(body, ctx)));
      case 'POST /api/sync':
        return sendJson(res, 202, startJob('sync', 'Κατέβασμα από το Google Drive', (ctx) => operations.syncFromDrive(body, ctx)));
      case 'POST /api/mail':
        return sendJson(res, 200, { result: await operations.mailFolder(body) });
      case 'POST /api/remove-zips':
        return sendJson(res, 200, { result: await operations.removeZipFiles(body) });
      case 'POST /api/remove-archive':
        return sendJson(res, 200, { result: await operations.removeArchive(body) });
      case 'POST /api/delete-local':
        return sendJson(res, 200, { result: operations.deleteLocal(body) });
    }
    throw new HttpError(404, 'Not found');
  }

  async function handle(req, res) {
    // Only answer requests addressed to this computer (blocks DNS rebinding).
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'Forbidden');

    const url = new URL(req.url, `http://${host}`);

    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    if (url.pathname === '/' || url.pathname === '/index.html') return servePage(res);
    if (STATIC_FILES[url.pathname]) return serveStatic(res, url.pathname);
    if (url.pathname.startsWith('/files/')) return serveArchiveFile(req, res, url);

    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) { res.destroy(); return; }
      let status = 500;
      let message = err.message;
      if (err instanceof HttpError) status = err.status;
      else if (err instanceof InputError || err instanceof SettingsError) status = 400;
      else if (err instanceof JobBusyError) status = 409;
      else if (err instanceof BackendError) status = 502;
      else {
        console.error(err);
        message = 'Κάτι πήγε στραβά. Δοκίμασε ξανά.';
      }
      sendJson(res, status, { error: message });
    });
  });

  /** Listens on 127.0.0.1, moving to the next port when the wanted one is taken. */
  function listen() {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryListen = () => {
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && wantedPort !== 0 && attempts < PORT_ATTEMPTS) {
            attempts++;
            port++;
            tryListen();
          } else {
            reject(err);
          }
        });
        server.listen(port, '127.0.0.1', () => {
          server.removeAllListeners('error');
          port = server.address().port;
          resolve(`http://127.0.0.1:${port}/`);
        });
      };
      tryListen();
    });
  }

  function close() {
    return new Promise((resolve) => {
      server.close(() => resolve());
      if (server.closeAllConnections) server.closeAllConnections();
    });
  }

  return { server, listen, close, token, settings, store, jobs };
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command[0], command[1], { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch (err) { /* the URL is printed, the user can open it by hand */ }
}

async function main() {
  const noOpen = process.argv.includes('--no-open') || process.env.INVOICE_NO_OPEN === '1';

  let app;
  try {
    app = createApp();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const url = await app.listen();
  const view = app.settings.publicView();

  console.log('');
  console.log(`  Τα Τιμολόγια άνοιξαν στη διεύθυνση:  ${url}`);
  console.log(`  Τα αρχεία αποθηκεύονται στον φάκελο: ${app.store.rootDir}`);
  console.log(`  Οι ρυθμίσεις βρίσκονται στο αρχείο:  ${view.file}`);
  for (const notice of app.settings.notices) console.log(`  ${notice}`);
  if (!view.hasKey || !view.url) console.log('  ΠΡΟΣΟΧΗ: λείπουν ρυθμίσεις σύνδεσης. Συμπλήρωσέ τες από το κουμπί «Ρυθμίσεις» της σελίδας.');
  console.log('');
  console.log('  Για να κλείσει, πάτησε Ctrl+C.');

  if (!noOpen) openBrowser(url);

  const stop = () => { app.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { createApp };
