'use strict';
// The local server, tested end to end against the mock backend (which runs
// the real backend code), plus the local archive store on its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { Store, sanitizeName } = require('../server/store.js');
const { createApp } = require('../server/server.js');
const { startMockBackend, MOCK_SECRET } = require('../dev/mock-backend.js');
const { makePdf } = require('../dev/gas-shim.js');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MARCH = 'Τιμολόγια_Μάρτιος_2025';
const pdfA = makePdf(['A']);
const pdfB = makePdf(['B is longer']);

function threads() {
  return [
    { messages: [{ subject: 'Τιμολόγιο', from: 'ΔΕΗ <billing@dei.example>', date: new Date(2025, 2, 10, 12), attachments: [{ name: 'dei.pdf', bytes: pdfA }] }] },
    { messages: [{ subject: 'Invoice 1', from: 'shop@store.example', date: new Date(2025, 2, 12, 12), attachments: [{ name: 'inv: 1?.pdf', bytes: pdfB }] }] },
    { messages: [{ subject: 'Invoice', from: 'shop@store.example', date: new Date(2025, 3, 3, 12), attachments: [{ name: 'april.pdf', bytes: pdfA }] }] },
  ];
}

// ---- store ---------------------------------------------------------------

test('names are made safe for Windows', () => {
  assert.equal(sanitizeName('Τιμολόγια_1/03/2025-11/03/2025'), 'Τιμολόγια_1_03_2025-11_03_2025');
  assert.equal(sanitizeName('a<b>c:d"e|f?g*h\\i'), 'a_b_c_d_e_f_g_h_i');
  assert.equal(sanitizeName('trailing dots... '), 'trailing dots');
  assert.equal(sanitizeName('CON'), '_CON');
  assert.equal(sanitizeName('nul.pdf'), '_nul.pdf');
  assert.equal(sanitizeName('..'), '_');
  assert.equal(sanitizeName('.hidden.pdf'), '_hidden.pdf');
  assert.equal(sanitizeName('.index.json'), '_index.json');
  assert.equal(sanitizeName(''), '_');
  assert.equal(sanitizeName('tab\there'), 'tab_here');
  const long = sanitizeName('x'.repeat(300) + '.pdf');
  assert.equal(long.length, 150);
  assert.ok(long.endsWith('.pdf'));
});

test('store saves, finds and lists files, and survives a restart', (t) => {
  const dir = tempDir(t);
  const store = new Store(dir);
  const record = { id: 'id1', parent_folder: '2025', child_folder: MARCH, sender: 'a@x.example', name: 'Μάρτιος_inv.pdf', size: pdfA.length };

  assert.equal(store.hasFile(record), false);
  assert.equal(store.saveFile(record, pdfA), `2025/${MARCH}/a@x.example/Μάρτιος_inv.pdf`);
  store.flush();
  assert.equal(store.hasFile(record), true);
  assert.equal(store.hasFile({ ...record, size: record.size + 1 }), false, 'changed in Drive');

  const reopened = new Store(dir);
  assert.equal(reopened.hasFile(record), true);
  fs.rmSync(path.join(dir, '2025', MARCH, 'a@x.example', 'Μάρτιος_inv.pdf'));
  assert.equal(reopened.hasFile(record), false, 'deleted from disk');

  reopened.saveFile(record, pdfA);
  const month = reopened.tree()[0].children[0];
  assert.deepEqual(month.drive, { parent_folder: '2025', child_folder: MARCH });
  assert.equal(month.children[0].children[0].kind, 'pdf');
  assert.equal(month.children[0].children[0].size, pdfA.length);
});

test('two Drive names that clean up to the same local name are both kept', (t) => {
  const store = new Store(tempDir(t));
  const base = { parent_folder: 'NEWER_THAN', child_folder: 'Τιμολόγια_1/03/2025', sender: 's', size: 1 };
  const one = store.saveFile({ ...base, id: 'a', name: 'x:1.pdf' }, Buffer.from('1'));
  const two = store.saveFile({ ...base, id: 'b', name: 'x?1.pdf' }, Buffer.from('2'));
  const again = store.saveFile({ ...base, id: 'a', name: 'x:1.pdf' }, Buffer.from('1'));

  assert.equal(one, 'NEWER_THAN/Τιμολόγια_1_03_2025/s/x_1.pdf');
  assert.equal(two, 'NEWER_THAN/Τιμολόγια_1_03_2025/s/x_1 (2).pdf');
  assert.equal(again, one);
  assert.deepEqual(store.tree()[0].children[0].drive, { parent_folder: 'NEWER_THAN', child_folder: 'Τιμολόγια_1/03/2025' });
});

test('only plain files inside the archive can be resolved', (t) => {
  const dir = tempDir(t);
  const archive = path.join(dir, 'archives');
  fs.writeFileSync(path.join(dir, 'key'), 'secret');
  const store = new Store(archive);
  store.saveFile({ id: 'a', parent_folder: '2025', child_folder: MARCH, sender: 's', name: 'f.pdf', size: 1 }, pdfA);
  store.flush();
  fs.symlinkSync(path.join(dir, 'key'), path.join(archive, '2025', 'link.pdf'));

  assert.ok(store.resolveFile(`2025/${MARCH}/s/f.pdf`));
  for (const bad of ['../key', '2025/../../key', '/etc/passwd', '2025\\..\\..\\key', '', '.index.json', '2025', '2025/link.pdf',
    `2025/${MARCH}/s/missing.pdf`, 'C:/Windows/win.ini', `2025/${MARCH}//s/f.pdf`]) {
    assert.equal(store.resolveFile(bad), null, bad);
  }
});

test('removing a local folder deletes its files and index entries', (t) => {
  const dir = tempDir(t);
  const store = new Store(dir);
  const rec = { id: 'a', parent_folder: '2025', child_folder: MARCH, sender: 's', name: 'f.pdf', size: pdfA.length };
  store.saveFile(rec, pdfA);
  assert.equal(store.removeFolder('2025', MARCH), true);
  assert.equal(store.hasFile(rec), false);
  assert.deepEqual(store.tree(), []);
  assert.equal(store.removeFolder('2025', MARCH), false);
});

// ---- server --------------------------------------------------------------

async function startClient(t, { key = MOCK_SECRET, mockOptions = {} } = {}) {
  const dir = tempDir(t);
  const mock = await startMockBackend({ threads: threads(), ...mockOptions });
  const keyFile = path.join(dir, 'key');
  if (key !== null) fs.writeFileSync(keyFile, key + '\r\n');

  const app = createApp({ url: mock.url, keyFile, archiveDir: path.join(dir, 'archives'), port: 0 });
  const base = await app.listen();
  t.after(async () => { await app.close(); await mock.close(); });

  const api = async (method, route, body, headers = {}) => {
    const res = await fetch(base + route.replace(/^\//, ''), {
      method,
      headers: { 'X-Session-Token': app.token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  };

  const runJob = async (route, body) => {
    const started = await api('POST', route, body);
    assert.equal(started.status, 202, JSON.stringify(started.data));
    for (;;) {
      const { data } = await api('GET', `/api/jobs/${started.data.job.id}`);
      if (data.job.status !== 'running') return data.job;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  return { app, mock, base, dir, api, runJob };
}

const marchAndApril = { mode: 'months', months: [{ month: 4, year: 2025 }, { month: 3, year: 2025 }] };

test('the page gets the session token and the API refuses calls without it', async (t) => {
  const c = await startClient(t);

  const page = await fetch(c.base);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes(c.app.token));
  assert.ok(!html.includes(MOCK_SECRET));
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);

  assert.equal((await c.api('GET', '/api/state', null, { 'X-Session-Token': 'wrong' })).status, 403);
  assert.equal((await c.api('POST', '/api/delete-local', { parent_folder: '2025', child_folder: MARCH }, { 'X-Session-Token': '' })).status, 403);
  assert.deepEqual((await c.api('GET', '/api/state')).data, { hasKey: true, hasUrl: true, archiveDir: path.join(c.dir, 'archives'), runningJob: null });
});

test('requests for another host name are refused', async (t) => {
  const c = await startClient(t);
  const port = new URL(c.base).port;
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: `evil.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('fetch saves the invoices to Drive and to disk, and the files can be opened', async (t) => {
  const c = await startClient(t);
  const job = await c.runJob('/api/fetch', marchAndApril);

  assert.equal(job.status, 'done', job.error);
  assert.deepEqual(
    { saved: job.result.saved, existing: job.result.existing, downloaded: job.result.downloaded, failed: job.result.failed, errors: job.result.errors },
    { saved: 3, existing: 0, downloaded: 3, failed: [], errors: [] });
  assert.deepEqual(job.result.folders, [`2025/${MARCH}`, '2025/Τιμολόγια_Απρίλιος_2025']);

  // on disk, with the Windows-unsafe name cleaned up
  const local = path.join(c.dir, 'archives', '2025', MARCH);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(local, 'billing@dei.example', 'Μάρτιος_dei.pdf')), pdfA), 0);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(local, 'shop@store.example', 'Μάρτιος_inv_ 1_.pdf')), pdfB), 0);

  // in the tree
  const { data } = await c.api('GET', '/api/tree');
  const year = data.tree.find((n) => n.name === '2025');
  assert.deepEqual(year.children.map((m) => m.name).sort(), ['Τιμολόγια_Απρίλιος_2025', MARCH].sort());
  const file = year.children.find((m) => m.name === MARCH).children.find((s) => s.name === 'shop@store.example').children[0];
  assert.equal(file.kind, 'pdf');

  // served inline for the viewer
  const res = await fetch(c.base + 'files/' + file.path.split('/').map(encodeURIComponent).join('/'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /^inline;/);
  assert.equal(Buffer.compare(Buffer.from(await res.arrayBuffer()), pdfB), 0);

  // a second fetch downloads nothing
  const again = await c.runJob('/api/fetch', marchAndApril);
  assert.deepEqual([again.result.saved, again.result.existing, again.result.downloaded], [0, 3, 0]);
  assert.equal(c.mock.requests.filter((r) => r.exec_type === 'GET_FILES').length, 2);
});

test('files outside the archive are never served', async (t) => {
  const c = await startClient(t);
  await c.runJob('/api/fetch', marchAndApril);
  for (const route of ['files/..%2Fkey', 'files/%2e%2e/key', 'files/2025/..%2F..%2Fkey', 'files/.index.json', 'files/%00', 'files/2025', 'key', 'server/server.js']) {
    const res = await fetch(c.base + route);
    assert.equal(res.status, 404, route);
    assert.ok(!(await res.text()).includes(MOCK_SECRET));
  }
});

test('fetch by days, with a copy by email', async (t) => {
  const recent = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  const c = await startClient(t, {
    mockOptions: { threads: [{ messages: [{ subject: 'Invoice', from: 'a@x.example', date: recent, attachments: [{ name: 'new.pdf', bytes: pdfA }] }] }] },
  });
  const job = await c.runJob('/api/fetch', { mode: 'newer_than', newer_than: 7, inspect: true });

  assert.equal(job.status, 'done', job.error);
  assert.deepEqual([job.result.saved, job.result.downloaded, job.result.mailed], [1, 1, 1]);
  assert.deepEqual(c.mock.gas.sent.map((m) => m.to), ['me@example.com']);
  assert.deepEqual(JSON.parse(c.mock.requests[0].body), { fetch_type: 'NEWER_THAN', newer_than: 7 });
});

test('sync downloads what is in Drive but not on disk', async (t) => {
  const c = await startClient(t);
  await c.runJob('/api/fetch', marchAndApril);
  fs.rmSync(path.join(c.dir, 'archives', '2025', MARCH), { recursive: true });
  c.mock.gas.find('2025', MARCH).createFile('old.zip', 'zip');

  const remote = await c.api('GET', '/api/remote');
  assert.deepEqual(remote.data.structure, { 2025: [MARCH, 'Τιμολόγια_Απρίλιος_2025'] });

  const one = await c.runJob('/api/sync', { folders: [{ parent_folder: '2025', child_folder: MARCH }] });
  assert.deepEqual([one.result.downloaded, one.result.alreadyLocal], [2, 0]);
  assert.ok(!fs.existsSync(path.join(c.dir, 'archives', '2025', MARCH, 'old.zip')), 'zips are not mirrored');

  const all = await c.runJob('/api/sync', {});
  assert.deepEqual([all.result.downloaded, all.result.alreadyLocal], [0, 3]);
});

test('mail, remove zips and remove archive go through to the backend', async (t) => {
  const c = await startClient(t);
  await c.runJob('/api/fetch', marchAndApril);
  const folder = { parent_folder: '2025', child_folder: MARCH };

  const mail = await c.api('POST', '/api/mail', { ...folder, mail_to: 'friend@else.example' });
  assert.equal(mail.status, 200, JSON.stringify(mail.data));
  assert.equal(mail.data.result.mode, 'attachment');
  assert.equal((await c.api('POST', '/api/mail', { ...folder, mail_to: 'ACCOUNTANT' })).status, 200);
  assert.deepEqual(c.mock.gas.sent.map((m) => m.to), ['friend@else.example', 'accountant@example.com']);

  const bad = await c.api('POST', '/api/mail', { ...folder, mail_to: 'nope' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /valid email/);

  c.mock.gas.find('2025', MARCH).createFile('old.zip', 'zip');
  assert.deepEqual((await c.api('POST', '/api/remove-zips', folder)).data.result, { removed: 1 });

  const keepLocal = await c.api('POST', '/api/remove-archive', { parent_folder: '2025', child_folder: 'Τιμολόγια_Απρίλιος_2025' });
  assert.deepEqual(keepLocal.data.result, { removed: true, localRemoved: false });
  assert.ok(fs.existsSync(path.join(c.dir, 'archives', '2025', 'Τιμολόγια_Απρίλιος_2025')));
  assert.deepEqual((await c.api('POST', '/api/delete-local', { parent_folder: '2025', child_folder: 'Τιμολόγια_Απρίλιος_2025' })).data.result, { localRemoved: true });

  const both = await c.api('POST', '/api/remove-archive', { ...folder, delete_local: true });
  assert.deepEqual(both.data.result, { removed: true, localRemoved: true });
  assert.deepEqual((await c.api('GET', '/api/tree')).data.tree, []);
  assert.deepEqual((await c.api('GET', '/api/remote')).data.structure, { 2025: [] });

  const gone = await c.api('POST', '/api/remove-archive', folder);
  assert.equal(gone.status, 502);
  assert.match(gone.data.error, /was not found/);
});

test('bad input is refused before anything is sent', async (t) => {
  const c = await startClient(t);
  const cases = [
    { mode: 'months', months: [] },
    { mode: 'months', months: [{ month: 13, year: 2025 }] },
    { mode: 'months', months: [{ month: 3, year: new Date().getFullYear() + 1 }] },
    { mode: 'newer_than', newer_than: 0 },
    { mode: 'newer_than', newer_than: 'abc' },
    {},
  ];
  for (const body of cases) {
    const job = await c.runJob('/api/fetch', body);
    assert.equal(job.status, 'error', JSON.stringify(body));
  }
  assert.equal(c.mock.requests.length, 0);
  assert.equal((await c.api('POST', '/api/mail', { mail_to: 'USER' })).status, 400);
});

test('only one job runs at a time', async (t) => {
  const c = await startClient(t);
  const first = await c.api('POST', '/api/fetch', marchAndApril);
  const second = await c.api('POST', '/api/sync', {});
  assert.equal(first.status, 202);
  assert.equal(second.status, 409);
  assert.match(second.data.error, /still running/);
  await c.app.jobs.get(first.data.job.id).promise;
});

test('a missing key or a wrong key gives a clear error', async (t) => {
  const none = await startClient(t, { key: null });
  assert.equal((await none.api('GET', '/api/state')).data.hasKey, false);
  const job = await none.runJob('/api/fetch', marchAndApril);
  assert.equal(job.status, 'error');
  assert.match(job.error, /key file is missing/i);

  const wrong = await startClient(t, { key: 'not-the-key' });
  const remote = await wrong.api('GET', '/api/remote');
  assert.equal(remote.status, 502);
  assert.match(remote.data.error, /Invalid signature/);
});

test('an unreachable backend is reported, not hung', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'key'), 'k');
  const app = createApp({ url: 'http://127.0.0.1:9/exec', keyFile: path.join(dir, 'key'), archiveDir: path.join(dir, 'a'), port: 0 });
  const base = await app.listen();
  t.after(() => app.close());
  const res = await fetch(base + 'api/remote', { headers: { 'X-Session-Token': app.token } });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Could not reach the backend/);
});
