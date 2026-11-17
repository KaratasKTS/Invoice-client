'use strict';
// The local server, tested end to end against the mock backend (which runs
// the real backend code), plus the local archive store and the settings file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { Store, sanitizeName } = require('../server/store.js');
const { Settings } = require('../server/config.js');
const { createApp } = require('../server/server.js');
const { startMockBackend, MOCK_SECRET } = require('../dev/mock-backend.js');
const { makePdf } = require('../dev/gas-shim.js');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-client-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MARCH = 'Τιμολόγια_Μάρτιος_2025';
const APRIL = 'Τιμολόγια_Απρίλιος_2025';
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
  fs.writeFileSync(path.join(dir, 'config.json'), 'secret');
  const store = new Store(archive);
  store.saveFile({ id: 'a', parent_folder: '2025', child_folder: MARCH, sender: 's', name: 'f.pdf', size: 1 }, pdfA);
  store.flush();
  fs.symlinkSync(path.join(dir, 'config.json'), path.join(archive, '2025', 'link.pdf'));

  assert.ok(store.resolveFile(`2025/${MARCH}/s/f.pdf`));
  for (const bad of ['../config.json', '2025/../../config.json', '/etc/passwd', '2025\\..\\..\\config.json', '', '.index.json', '2025', '2025/link.pdf',
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

test('removing single files keeps the rest and tidies empty folders', (t) => {
  const dir = tempDir(t);
  const store = new Store(dir);
  const base = { parent_folder: '2025', child_folder: MARCH, size: pdfA.length };
  store.saveFile({ ...base, id: 'a', sender: 'one@x.example', name: 'a.pdf' }, pdfA);
  store.saveFile({ ...base, id: 'b', sender: 'one@x.example', name: 'b.pdf' }, pdfA);
  store.saveFile({ ...base, id: 'c', sender: 'two@x.example', name: 'c.pdf' }, pdfA);

  assert.equal(store.removeFiles(['b', 'c', 'unknown']), 2);
  assert.ok(fs.existsSync(path.join(dir, '2025', MARCH, 'one@x.example', 'a.pdf')));
  assert.ok(!fs.existsSync(path.join(dir, '2025', MARCH, 'two@x.example')), 'empty sender folder is removed');
  assert.equal(store.hasFile({ ...base, id: 'a' }), true);
  assert.equal(store.hasFile({ ...base, id: 'b' }), false);

  assert.equal(store.removeFiles(['a']), 1);
  assert.deepEqual(store.tree(), [], 'month and year folders are removed once empty');
  assert.deepEqual(new Store(dir).index.folders, {});
});

// ---- settings file ---------------------------------------------------------

test('settings start from the template and take over the old key file', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'config.example.json'), JSON.stringify({ url: 'https://script.google.com/macros/s/abc/exec', key: '', port: 5000 }));
  fs.writeFileSync(path.join(dir, 'key'), 'old-secret\r\n');

  const settings = new Settings({ file: path.join(dir, 'config.json'), env: {} });
  assert.equal(settings.url, 'https://script.google.com/macros/s/abc/exec');
  assert.equal(settings.key, 'old-secret');
  assert.equal(settings.port, 5000);
  assert.equal(settings.notices.length, 1);

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(saved, { url: 'https://script.google.com/macros/s/abc/exec', key: 'old-secret', accountantEmail: '', port: 5000, archiveDir: 'archives' });
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600);

  // a second start changes nothing and does not import again
  const again = new Settings({ file: path.join(dir, 'config.json'), env: {} });
  assert.equal(again.notices.length, 0);
  assert.equal(again.key, 'old-secret');
});

test('settings can be changed, are checked, and never hand out the key', (t) => {
  const dir = tempDir(t);
  const settings = new Settings({ file: path.join(dir, 'config.json'), env: {} });
  assert.equal(settings.key, null);

  const view = settings.update({ url: ' https://script.google.com/macros/s/x/exec ', accountantEmail: 'acc@firm.example', key: ' s3cret\n' });
  assert.deepEqual({ ...view, archiveDir: '', file: '' }, { url: 'https://script.google.com/macros/s/x/exec', accountantEmail: 'acc@firm.example', hasKey: true, archiveDir: '', file: '' });
  assert.ok(!JSON.stringify(view).includes('s3cret'));
  assert.equal(settings.key, 's3cret');

  settings.update({ accountantEmail: '', key: '' });
  assert.equal(settings.key, 's3cret', 'an empty key keeps the stored one');
  assert.equal(settings.accountantEmail, '');

  assert.throws(() => settings.update({ url: 'not a url' }), /διεύθυνση/);
  assert.throws(() => settings.update({ url: 'ftp://example.com/x' }), /διεύθυνση/);
  assert.throws(() => settings.update({ accountantEmail: 'nope' }), /email/);
  assert.equal(new Settings({ file: path.join(dir, 'config.json'), env: {} }).url, 'https://script.google.com/macros/s/x/exec');
});

// ---- server --------------------------------------------------------------

async function startClient(t, { key = MOCK_SECRET, accountantEmail = '', mockOptions = {} } = {}) {
  const dir = tempDir(t);
  const mock = await startMockBackend({ threads: threads(), ...mockOptions });
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ url: mock.url, key: key || '', accountantEmail }));

  const app = createApp({ configFile, archiveDir: path.join(dir, 'archives'), port: 0 });
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

  const waitForJob = async (id, until = (job) => job.status !== 'running') => {
    for (;;) {
      const { data } = await api('GET', `/api/jobs/${id}`);
      if (until(data.job)) return data.job;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  const runJob = async (route, body) => {
    const started = await api('POST', route, body);
    assert.equal(started.status, 202, JSON.stringify(started.data));
    return waitForJob(started.data.job.id);
  };

  return { app, mock, base, dir, configFile, api, runJob, waitForJob };
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
  assert.equal((await c.api('POST', '/api/settings', { key: 'stolen' }, { 'X-Session-Token': 'wrong' })).status, 403);
  assert.deepEqual((await c.api('GET', '/api/state')).data,
    { hasKey: true, hasUrl: true, accountantEmail: '', archiveDir: path.join(c.dir, 'archives'), runningJob: null });
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
  assert.deepEqual(job.result.folders, [`2025/${MARCH}`, `2025/${APRIL}`]);
  assert.equal(job.downloadedCount, 3);
  assert.ok(job.log.some((line) => /Μάρτιος 2025: 2 νέα τιμολόγια/.test(line.message)), JSON.stringify(job.log));

  // on disk, with the Windows-unsafe name cleaned up
  const local = path.join(c.dir, 'archives', '2025', MARCH);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(local, 'billing@dei.example', 'Μάρτιος_dei.pdf')), pdfA), 0);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(local, 'shop@store.example', 'Μάρτιος_inv_ 1_.pdf')), pdfB), 0);

  // in the tree
  const { data } = await c.api('GET', '/api/tree');
  const year = data.tree.find((n) => n.name === '2025');
  assert.deepEqual(year.children.map((m) => m.name).sort(), [APRIL, MARCH].sort());
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
  assert.equal(again.downloadedCount, 0);
  assert.equal(c.mock.requests.filter((r) => r.exec_type === 'GET_FILES').length, 2);
});

test('files outside the archive are never served', async (t) => {
  const c = await startClient(t);
  await c.runJob('/api/fetch', marchAndApril);
  for (const route of ['files/..%2Fconfig.json', 'files/%2e%2e/config.json', 'files/2025/..%2F..%2Fconfig.json', 'files/.index.json', 'files/%00', 'files/2025', 'config.json', 'server/server.js']) {
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
  assert.deepEqual(remote.data.structure, { 2025: [MARCH, APRIL] });

  const one = await c.runJob('/api/sync', { folders: [{ parent_folder: '2025', child_folder: MARCH }] });
  assert.deepEqual([one.result.downloaded, one.result.alreadyLocal], [2, 0]);
  assert.ok(!fs.existsSync(path.join(c.dir, 'archives', '2025', MARCH, 'old.zip')), 'zips are not mirrored');

  const all = await c.runJob('/api/sync', {});
  assert.deepEqual([all.result.downloaded, all.result.alreadyLocal], [0, 3]);
});

test('a running fetch can be stopped, and what it downloaded can be removed', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // The answer for April never arrives until the test lets it through.
  const c = await startClient(t, {
    mockOptions: { beforeAnswer: ({ exec_type, body }) => (exec_type === 'FETCH' && JSON.parse(body).month === 4 ? gate : null) },
  });
  t.after(() => release());

  const started = await c.api('POST', '/api/fetch', marchAndApril);
  const id = started.data.job.id;

  // March is done (2 files on disk), April is waiting for the backend.
  const waiting = await c.waitForJob(id, (job) => job.log.some((line) => /Απρίλιος 2025: αναζήτηση/.test(line.message)));
  assert.equal(waiting.status, 'running');
  assert.equal(waiting.downloadedCount, 2);
  assert.equal((await c.api('POST', `/api/jobs/${id}/discard`, {})).status, 409, 'cannot discard while it runs');

  const cancel = await c.api('POST', `/api/jobs/${id}/cancel`, {});
  assert.equal(cancel.status, 200);
  const stopped = await c.waitForJob(id);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.error, null);
  assert.equal(stopped.downloadedCount, 2);
  assert.deepEqual([stopped.result.saved, stopped.result.downloaded], [2, 2], 'the partial result is kept');
  assert.equal((await c.api('GET', '/api/state')).data.runningJob, null);

  // the files of this run are still there until the user says to remove them
  const marchDir = path.join(c.dir, 'archives', '2025', MARCH);
  assert.ok(fs.existsSync(path.join(marchDir, 'billing@dei.example', 'Μάρτιος_dei.pdf')));

  const discard = await c.api('POST', `/api/jobs/${id}/discard`, {});
  assert.deepEqual(discard.data, { removed: 2 });
  assert.deepEqual((await c.api('GET', '/api/tree')).data.tree, []);
  assert.deepEqual((await c.api('POST', `/api/jobs/${id}/discard`, {})).data, { removed: 0 }, 'a second discard removes nothing');

  // Drive keeps what was found
  assert.equal(Object.keys(c.mock.gas.dump()['2025'][MARCH]).length, 2);

  // and a later run works normally
  release();
  const later = await c.runJob('/api/fetch', marchAndApril);
  assert.equal(later.status, 'done', later.error);
  assert.equal(later.result.downloaded, 3);
});

test('stopping removes only the files of that run, not earlier ones', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // The file list of March never arrives until the test lets it through.
  const c = await startClient(t, {
    mockOptions: { beforeAnswer: ({ exec_type, body }) => (exec_type === 'LIST_FILES' && JSON.parse(body).child_folder === MARCH ? gate : null) },
  });
  t.after(() => release());

  // Earlier runs: March and April are fetched, then April is deleted locally.
  await c.runJob('/api/fetch', marchAndApril);
  fs.rmSync(path.join(c.dir, 'archives', '2025', APRIL), { recursive: true });

  // This run downloads April again, then is stopped while it waits for March.
  const started = await c.api('POST', '/api/sync', { folders: [{ parent_folder: '2025', child_folder: APRIL }, { parent_folder: '2025', child_folder: MARCH }] });
  const id = started.data.job.id;
  const waiting = await c.waitForJob(id, (job) => job.downloadedCount === 1);
  assert.equal(waiting.status, 'running');

  await c.api('POST', `/api/jobs/${id}/cancel`, {});
  const stopped = await c.waitForJob(id);
  assert.equal(stopped.status, 'cancelled');
  assert.deepEqual((await c.api('POST', `/api/jobs/${id}/discard`, {})).data, { removed: 1 });

  assert.ok(!fs.existsSync(path.join(c.dir, 'archives', '2025', APRIL)), 'April, downloaded by this run, is gone');
  assert.equal(fs.readdirSync(path.join(c.dir, 'archives', '2025', MARCH)).length, 2, 'March, from the earlier run, stays');
});

test('settings are read and saved through the API without exposing the key', async (t) => {
  const c = await startClient(t, { key: null });

  const before = await c.api('GET', '/api/settings');
  assert.deepEqual({ ...before.data.settings, archiveDir: '' }, { url: c.mock.url, accountantEmail: '', hasKey: false, archiveDir: '', file: c.configFile });

  // without a key nothing reaches the backend
  const noKey = await c.api('POST', '/api/settings/test', {});
  assert.equal(noKey.status, 502);
  assert.match(noKey.data.error, /μυστικός κωδικός/);

  // a wrong key is reported as such
  await c.api('POST', '/api/settings', { key: 'wrong-key' });
  const wrong = await c.api('POST', '/api/settings/test', {});
  assert.equal(wrong.status, 502);
  assert.match(wrong.data.error, /δεν ταιριάζει/);

  // the right key works at once, with no restart
  const saved = await c.api('POST', '/api/settings', { url: c.mock.url, accountantEmail: 'acc@firm.example', key: MOCK_SECRET });
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved.data).includes(MOCK_SECRET));
  assert.equal(saved.data.settings.hasKey, true);
  await c.runJob('/api/fetch', marchAndApril);
  assert.deepEqual((await c.api('POST', '/api/settings/test', {})).data, { result: { ok: true, folders: 2 } });

  // on disk, in the one settings file
  const file = JSON.parse(fs.readFileSync(c.configFile, 'utf8'));
  assert.deepEqual([file.key, file.accountantEmail, file.url], [MOCK_SECRET, 'acc@firm.example', c.mock.url]);
  assert.equal((await c.api('GET', '/api/state')).data.accountantEmail, 'acc@firm.example');

  // bad values are refused and nothing changes
  assert.equal((await c.api('POST', '/api/settings', { url: 'nope' })).status, 400);
  assert.equal((await c.api('POST', '/api/settings', { accountantEmail: 'nope' })).status, 400);
  assert.equal(JSON.parse(fs.readFileSync(c.configFile, 'utf8')).accountantEmail, 'acc@firm.example');

  // a wrong address is reported too
  await c.api('POST', '/api/settings', { url: 'http://127.0.0.1:9/exec' });
  const unreachable = await c.api('POST', '/api/settings/test', {});
  assert.equal(unreachable.status, 502);
  assert.match(unreachable.data.error, /σύνδεση με την υπηρεσία/);
});

test('mail to the accountant uses the address from the settings', async (t) => {
  const c = await startClient(t);
  await c.runJob('/api/fetch', marchAndApril);
  const folder = { parent_folder: '2025', child_folder: MARCH };

  const missing = await c.api('POST', '/api/mail', { ...folder, mail_to: 'ACCOUNTANT' });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /email λογιστή/);
  assert.equal(c.mock.gas.sent.length, 0);

  await c.api('POST', '/api/settings', { accountantEmail: 'logistis@firm.example' });
  const sent = await c.api('POST', '/api/mail', { ...folder, mail_to: 'ACCOUNTANT' });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.result.mail_to, 'logistis@firm.example');
  assert.deepEqual(c.mock.gas.sent.map((m) => m.to), ['logistis@firm.example']);
});

test('mail, remove zips and remove archive go through to the backend', async (t) => {
  const c = await startClient(t);
  await c.runJob('/api/fetch', marchAndApril);
  const folder = { parent_folder: '2025', child_folder: MARCH };

  const mail = await c.api('POST', '/api/mail', { ...folder, mail_to: 'friend@else.example' });
  assert.equal(mail.status, 200, JSON.stringify(mail.data));
  assert.equal(mail.data.result.mode, 'attachment');
  assert.equal((await c.api('POST', '/api/mail', { ...folder, mail_to: 'USER' })).status, 200);
  assert.deepEqual(c.mock.gas.sent.map((m) => m.to), ['friend@else.example', 'me@example.com']);

  const bad = await c.api('POST', '/api/mail', { ...folder, mail_to: 'nope' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /έγκυρη διεύθυνση email/);

  c.mock.gas.find('2025', MARCH).createFile('old.zip', 'zip');
  assert.deepEqual((await c.api('POST', '/api/remove-zips', folder)).data.result, { removed: 1 });

  const keepLocal = await c.api('POST', '/api/remove-archive', { parent_folder: '2025', child_folder: APRIL });
  assert.deepEqual(keepLocal.data.result, { removed: true, localRemoved: false });
  assert.ok(fs.existsSync(path.join(c.dir, 'archives', '2025', APRIL)));
  assert.deepEqual((await c.api('POST', '/api/delete-local', { parent_folder: '2025', child_folder: APRIL })).data.result, { localRemoved: true });

  const both = await c.api('POST', '/api/remove-archive', { ...folder, delete_local: true });
  assert.deepEqual(both.data.result, { removed: true, localRemoved: true });
  assert.deepEqual((await c.api('GET', '/api/tree')).data.tree, []);
  assert.deepEqual((await c.api('GET', '/api/remote')).data.structure, { 2025: [] });

  const gone = await c.api('POST', '/api/remove-archive', folder);
  assert.equal(gone.status, 502);
  assert.equal(gone.data.error, `Ο φάκελος «2025 / ${MARCH}» δεν βρέθηκε στο Google Drive.`);
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
  assert.match(second.data.error, /Εκτελείται ήδη/);
  await c.app.jobs.get(first.data.job.id).promise;
});

test('a missing key or a wrong key gives a clear error', async (t) => {
  const none = await startClient(t, { key: null });
  assert.equal((await none.api('GET', '/api/state')).data.hasKey, false);
  const job = await none.runJob('/api/fetch', marchAndApril);
  assert.equal(job.status, 'error');
  assert.match(job.error, /μυστικός κωδικός/);

  const wrong = await startClient(t, { key: 'not-the-key' });
  const remote = await wrong.api('GET', '/api/remote');
  assert.equal(remote.status, 502);
  assert.match(remote.data.error, /δεν ταιριάζει/);
  const wrongJob = await wrong.runJob('/api/fetch', marchAndApril);
  assert.equal(wrongJob.status, 'error');
  assert.equal(wrong.mock.requests.length, 2, 'stops after the first rejected request');
});

test('an unreachable backend is reported, not hung', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ url: 'http://127.0.0.1:9/exec', key: 'k' }));
  const app = createApp({ configFile: path.join(dir, 'config.json'), archiveDir: path.join(dir, 'a'), port: 0 });
  const base = await app.listen();
  t.after(() => app.close());
  const res = await fetch(base + 'api/remote', { headers: { 'X-Session-Token': app.token } });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /σύνδεση με την υπηρεσία/);
});
