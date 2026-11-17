'use strict';
// A stand-in for the deployed Apps Script web app, for local development.
// It runs the real backend/*.gs code on fake Gmail and Drive data and answers
// the same way Apps Script does (a POST that redirects to a GET).
//
//   node dev/mock-backend.js [port]        default port 4790, key "mock-key"
//
// It writes a ready settings file and prints the command that starts the
// client against it. MOCK_DELAY=<ms> makes every answer slow, which is handy
// for trying the Stop button.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGas, makePdf } = require('./gas-shim.js');

const MOCK_SECRET = 'mock-key';

/** Sample mailbox: invoices in this month, earlier months and last year. */
function sampleThreads(now = new Date()) {
  const at = (monthsBack, day, hour = 10) => {
    const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, day, hour);
    return d > now ? new Date(now.getTime() - 3600 * 1000) : d;
  };
  const label = (d) => d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const invoice = (from, subject, date, file, lines) => ({
    messages: [{ from, subject, date, attachments: [{ name: file, bytes: makePdf(lines.concat('Date: ' + date.toDateString())) }] }],
  });

  const threads = [];
  for (let back = 0; back <= 3; back++) {
    const power = at(back, 4);
    const phone = at(back, 9);
    const host = at(back, 12);
    threads.push(invoice('ΔΕΗ <ebill@dei.example>', 'Τιμολόγιο ρεύματος ' + label(power), power, 'dei-logariasmos.pdf',
      ['DEI - Electricity invoice', 'Period: ' + label(power), 'Amount due: ' + (80 + back * 7) + '.40 EUR']));
    threads.push(invoice('COSMOTE <billing@cosmote.example>', 'Ο λογαριασμός σας - παραστατικό', phone, 'cosmote.pdf',
      ['COSMOTE - Mobile and internet', 'Period: ' + label(phone), 'Amount due: 42.90 EUR']));
    threads.push(invoice('billing@hosting.example', 'Your invoice #' + (1040 - back), host, 'invoice.pdf',
      ['Hosting Ltd - Invoice #' + (1040 - back), 'VPS plan M', 'Total: 19.00 EUR']));
  }

  // Two different invoices with the same file name, same sender, same month
  const extra = at(0, 14);
  threads.push(invoice('billing@hosting.example', 'Your invoice #1041 (domain renewal)', extra, 'invoice.pdf',
    ['Hosting Ltd - Invoice #1041', 'Domain renewal', 'Total: 12.00 EUR']));

  // The same PDF forwarded a second time (must be saved once)
  const fwdDate = at(1, 15);
  const fwdPdf = makePdf(['Office Supplies SA', 'Invoice 7781', 'Total: 133.20 EUR']);
  threads.push({ messages: [{ from: 'sales@supplies.example', subject: 'Τιμολόγιο 7781', date: fwdDate, attachments: [{ name: 'timologio-7781.pdf', bytes: fwdPdf }] }] });
  threads.push({ messages: [{ from: 'sales@supplies.example', subject: 'Fwd: Τιμολόγιο 7781', date: at(1, 16), attachments: [{ name: 'timologio-7781.pdf', bytes: fwdPdf }] }] });

  // Not an invoice (must be ignored)
  threads.push({ messages: [{ from: 'news@shop.example', subject: 'Winter catalogue', date: at(0, 6), attachments: [{ name: 'catalogue.pdf', bytes: makePdf(['Catalogue']) }] }] });

  // Last year
  const lastYear = new Date(now.getFullYear() - 1, 11, 18, 11);
  threads.push(invoice('logistirio@accounting.example', 'Τιμολόγιο παροχής υπηρεσιών', lastYear, 'timologio-dec.pdf',
    ['Accounting Office', 'Services December', 'Total: 150.00 EUR']));

  return threads;
}

/**
 * options.beforeAnswer({ exec_type, body }): awaited after the work is done and
 * before the answer is sent, to make the backend slow in tests.
 */
function startMockBackend({ port = 0, threads, secret = MOCK_SECRET, gasOptions = {}, beforeAnswer } = {}) {
  const gas = createGas({ secret, threads: threads || sampleThreads(), ...gasOptions });
  const results = new Map();
  const requests = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');

    if (req.method === 'POST' && url.pathname === '/exec') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const query = Object.fromEntries(url.searchParams);
        requests.push({ exec_type: query.exec_type, body });
        // Like the real script, the work is done even when the caller stops waiting.
        const payload = JSON.stringify(gas.handle(query, body));
        if (beforeAnswer) await beforeAnswer({ exec_type: query.exec_type, body });
        if (res.destroyed) return;
        const id = crypto.randomBytes(8).toString('hex');
        results.set(id, payload);
        res.writeHead(302, { Location: `/result/${id}` });
        res.end();
      });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/result/')) {
      const id = url.pathname.slice('/result/'.length);
      const payload = results.get(id);
      results.delete(id);
      if (payload === undefined) { res.writeHead(404); res.end('gone'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(payload);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/__sent') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(gas.sent.map((m) => ({ to: m.to, subject: m.subject, attachments: m.attachments.map((a) => a.name) })), null, 2));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        gas, server, requests, secret,
        url: `http://127.0.0.1:${address.port}/exec`,
        close: () => new Promise((done) => {
          server.close(() => done());
          if (server.closeAllConnections) server.closeAllConnections();
        }),
      });
    });
  });
}

module.exports = { startMockBackend, sampleThreads, MOCK_SECRET };

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.MOCK_PORT || 4790);
  const delay = Number(process.env.MOCK_DELAY || 0);
  const beforeAnswer = delay ? () => new Promise((resolve) => setTimeout(resolve, delay)) : undefined;

  startMockBackend({ port, beforeAnswer }).then((mock) => {
    const dir = path.join(os.tmpdir(), 'invoice-client-mock');
    const configFile = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ url: mock.url, key: MOCK_SECRET, accountantEmail: '', port: 4780, archiveDir: 'archives' }, null, 2));

    console.log(`Mock backend running at ${mock.url}${delay ? ` (every answer takes ${delay} ms)` : ''}`);
    console.log(`Sent mail: ${mock.url.replace('/exec', '/__sent')}`);
    console.log('');
    console.log('Start the client against it with:');
    console.log(`  INVOICE_CONFIG=${configFile} INVOICE_ARCHIVE_DIR=${path.join(dir, 'archives')} ./start.sh`);
  });
}
