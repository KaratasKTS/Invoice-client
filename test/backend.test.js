'use strict';
// Runs the real backend/*.gs code against fake Apps Script services.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGas, makePdf } = require('../dev/gas-shim.js');

const MARCH = 'Τιμολόγια_Μάρτιος_2025';
const APRIL = 'Τιμολόγια_Απρίλιος_2025';
const DAY = 24 * 60 * 60 * 1000;

const pdfA = makePdf(['Invoice A']);
const pdfB = makePdf(['Invoice B, a different one']);
const pdfC = makePdf(['Invoice C']);

function marchThreads() {
  return [
    {
      messages: [{
        subject: 'Τιμολόγιο Μαρτίου', from: 'ΔΕΗ <billing@dei.example>', date: new Date(2025, 2, 10, 12),
        attachments: [{ name: 'dei-march.pdf', bytes: pdfA }],
      }],
    },
    {
      // subject says nothing, the file name does
      messages: [{
        subject: 'Your documents', from: 'shop@store.example', date: new Date(2025, 2, 20, 9),
        attachments: [
          { name: 'Invoice_123.pdf', bytes: pdfB },
          { name: 'terms.png', bytes: Buffer.from('png'), contentType: 'image/png' },
        ],
      }],
    },
    {
      // not an invoice at all
      messages: [{
        subject: 'Newsletter', from: 'news@store.example', date: new Date(2025, 2, 21, 9),
        attachments: [{ name: 'menu.pdf', bytes: pdfC }],
      }],
    },
    {
      // one thread, a March message and an April reply
      subject: 'Παραστατικό',
      messages: [
        { subject: 'Παραστατικό', from: 'acc@firm.example', date: new Date(2025, 2, 31, 23, 30), attachments: [{ name: 'p1.pdf', bytes: pdfA }] },
        { subject: 'Re: Παραστατικό', from: 'acc@firm.example', date: new Date(2025, 3, 2, 10), attachments: [{ name: 'p2.pdf', bytes: pdfB }] },
      ],
    },
  ];
}

const fetchMarch = { fetch_type: 'MONTH_YEAR', month: '3', year: '2025' };

test('rejects bad signatures, old timestamps and replays under another action', () => {
  const gas = createGas();
  const body = JSON.stringify({ parent_folder: '2025', child_folder: MARCH, mail_to: 'USER' });
  const ts = String(Math.floor(Date.now() / 1000));

  assert.equal(gas.post('FETCH_DIR_STRUCTURE', {}, { sig: 'deadbeef' }).error, 'Invalid signature');
  assert.equal(gas.post('FETCH_DIR_STRUCTURE', {}, { ts: String(Number(ts) - 3600) }).error, 'Expired');
  assert.equal(gas.handle({ exec_type: 'FETCH_DIR_STRUCTURE' }, '{}').error, 'Missing ts/sig');

  // a signature made for MAILER_EXECUTE must not work for REMOVE_ARCHIVES
  const sig = gas.sign(ts, 'MAILER_EXECUTE', body);
  assert.equal(gas.handle({ ts, sig, exec_type: 'REMOVE_ARCHIVES' }, body).error, 'Invalid signature');

  // the old signature format (ts.body) is no longer accepted
  const crypto = require('node:crypto');
  const oldSig = crypto.createHmac('sha256', gas.secret).update(`${ts}.${body}`).digest('hex');
  assert.equal(gas.handle({ ts, sig: oldSig, exec_type: 'MAILER_EXECUTE' }, body).error, 'Invalid signature');
});

test('answers with JSON for bad JSON, unknown actions and a missing secret', () => {
  const gas = createGas();
  assert.equal(gas.post('FETCH', undefined, { body: '{not json' }).error, 'Body is not valid JSON');
  assert.match(gas.post('SOMETHING_ELSE', {}).error, /Unknown action/);
  assert.equal(gas.post('FETCH', undefined, { body: '[1,2]' }).ok, false);
  assert.equal(createGas({ secret: '' }).post('FETCH', {}, { sig: 'x' }).error, 'Server not configured');
});

test('month fetch files invoices by sender and by the date of each message', () => {
  const gas = createGas({ threads: marchThreads() });
  const res = gas.post('FETCH', fetchMarch);

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(gas.dump(), {
    2025: {
      [MARCH]: {
        'billing@dei.example': { 'Μάρτιος_dei-march.pdf': pdfA.length },
        'shop@store.example': { 'Μάρτιος_Invoice_123.pdf': pdfB.length },
        'acc@firm.example': { 'Μάρτιος_p1.pdf': pdfA.length },
      },
    },
  });
  assert.equal(res.return_value.saved.length, 3);
  assert.equal(res.return_value.existing.length, 0);

  const record = res.return_value.saved.find((f) => f.sender === 'shop@store.example');
  assert.deepEqual(
    { ...record, id: 'x' },
    { id: 'x', parent_folder: '2025', child_folder: MARCH, sender: 'shop@store.example', name: 'Μάρτιος_Invoice_123.pdf', size: pdfB.length });
  assert.equal(gas.find('2025', MARCH, 'shop@store.example', 'Μάρτιος_Invoice_123.pdf').getId(), record.id);

  // April reply of the same thread lands in April when April is fetched
  gas.post('FETCH', { fetch_type: 'MONTH_YEAR', month: 4, year: 2025 });
  assert.deepEqual(gas.dump()['2025'][APRIL], { 'acc@firm.example': { 'Απρίλιος_p2.pdf': pdfB.length } });
});

test('fetching twice saves nothing new and reports the files as existing', () => {
  const gas = createGas({ threads: marchThreads() });
  const first = gas.post('FETCH', fetchMarch).return_value;
  const before = JSON.stringify(gas.dump());
  const second = gas.post('FETCH', fetchMarch).return_value;

  assert.equal(second.saved.length, 0);
  assert.deepEqual(second.existing.map((f) => f.id).sort(), first.saved.map((f) => f.id).sort());
  assert.equal(JSON.stringify(gas.dump()), before);
});

test('the same PDF in two emails is saved once', () => {
  const gas = createGas({
    threads: [
      { messages: [{ subject: 'Invoice', from: 'a@x.example', date: new Date(2025, 2, 5), attachments: [{ name: 'inv.pdf', bytes: pdfA }] }] },
      { messages: [{ subject: 'Fwd: Invoice', from: 'a@x.example', date: new Date(2025, 2, 6), attachments: [{ name: 'inv.pdf', bytes: pdfA }] }] },
    ],
  });
  const res = gas.post('FETCH', fetchMarch).return_value;
  assert.equal(res.saved.length, 1);
  assert.deepEqual(gas.dump()['2025'][MARCH], { 'a@x.example': { 'Μάρτιος_inv.pdf': pdfA.length } });
});

test('two different invoices with the same file name are both kept', () => {
  const gas = createGas({
    threads: [
      { messages: [{ subject: 'Invoice 1', from: 'a@x.example', date: new Date(2025, 2, 5), attachments: [{ name: 'invoice.pdf', bytes: pdfA }] }] },
      { messages: [{ subject: 'Invoice 2', from: 'a@x.example', date: new Date(2025, 2, 25), attachments: [{ name: 'invoice.pdf', bytes: pdfB }] }] },
    ],
  });
  const expected = { 'a@x.example': { 'Μάρτιος_invoice.pdf': pdfA.length, 'Μάρτιος_invoice (2).pdf': pdfB.length } };

  assert.equal(gas.post('FETCH', fetchMarch).return_value.saved.length, 2);
  assert.deepEqual(gas.dump()['2025'][MARCH], expected);

  const again = gas.post('FETCH', fetchMarch).return_value;
  assert.equal(again.saved.length, 0);
  assert.equal(again.existing.length, 2);
  assert.deepEqual(gas.dump()['2025'][MARCH], expected);
});

test('an attachment whose reported size is off does not pile up copies', () => {
  const gas = createGas({
    threads: [{
      messages: [{ subject: 'Invoice', from: 'a@x.example', date: new Date(2025, 2, 5), attachments: [{ name: 'inv.pdf', bytes: pdfA, reportedSize: pdfA.length + 7 }] }],
    }],
  });
  gas.post('FETCH', fetchMarch);
  gas.post('FETCH', fetchMarch);
  assert.deepEqual(gas.dump()['2025'][MARCH], { 'a@x.example': { 'Μάρτιος_inv.pdf': pdfA.length } });
});

test('newer_than uses the number of days asked for and the normal year/month tree', () => {
  const recent = new Date(Date.now() - 3 * DAY);
  const old = new Date(Date.now() - 40 * DAY);
  const gas = createGas({
    threads: [
      { messages: [{ subject: 'Invoice new', from: 'a@x.example', date: recent, attachments: [{ name: 'new.pdf', bytes: pdfA }] }] },
      { messages: [{ subject: 'Invoice old', from: 'a@x.example', date: old, attachments: [{ name: 'old.pdf', bytes: pdfB }] }] },
    ],
  });

  const five = gas.post('FETCH', { fetch_type: 'NEWER_THAN', newer_than: '5', month: '0', year: '0', action: '' });
  assert.equal(five.ok, true, five.error);
  assert.deepEqual(five.params, { fetch_type: 'NEWER_THAN', newer_than: 5 });
  assert.deepEqual(five.return_value.saved.map((f) => f.name.replace(/^[^_]+_/, '')), ['new.pdf']);
  assert.equal(five.return_value.saved[0].parent_folder, String(recent.getFullYear()));
  assert.equal(gas.find('NEWER_THAN'), null);

  const sixty = gas.post('FETCH', { fetch_type: 'NEWER_THAN', newer_than: 60 }).return_value;
  assert.deepEqual(sixty.saved.map((f) => f.name.replace(/^[^_]+_/, '')), ['old.pdf']);
  assert.equal(sixty.existing.length, 1);
});

test('rejects invalid parameters with a clear error', () => {
  const gas = createGas();
  const bad = (type, params, pattern) => {
    const res = gas.post(type, params);
    assert.equal(res.ok, false, JSON.stringify(params));
    assert.match(res.error, pattern);
  };
  bad('FETCH', { fetch_type: 'NEWER_THAN', newer_than: '0' }, /newer_than/);
  bad('FETCH', { fetch_type: 'NEWER_THAN', newer_than: '91' }, /newer_than/);
  bad('FETCH', { fetch_type: 'NEWER_THAN', newer_than: 'abc' }, /newer_than/);
  bad('FETCH', { fetch_type: 'NEWER_THAN', newer_than: '' }, /newer_than/);
  bad('FETCH', { fetch_type: 'MONTH_YEAR', month: '13', year: '2025' }, /month/);
  bad('FETCH', { fetch_type: 'MONTH_YEAR', month: '3', year: String(new Date().getFullYear() + 1) }, /year/);
  bad('FETCH', { fetch_type: 'WHATEVER' }, /fetch_type/);
  bad('MAILER_EXECUTE', { parent_folder: '2025', child_folder: MARCH, mail_to: 'not-an-email' }, /mail_to/);
  bad('MAILER_EXECUTE', { parent_folder: '', child_folder: MARCH, mail_to: 'USER' }, /parent_folder/);
  bad('GET_FILES', { ids: [] }, /ids/);
  bad('GET_FILES', { ids: ['../etc'] }, /invalid file ID/);
  bad('FETCH_DIR_STRUCTURE', { action: 'NOPE' }, /does not exist/);
  assert.equal(gas.sent.length, 0);
});

test('month 0 and year 0 mean the current month and year', () => {
  const now = new Date();
  const res = createGas().post('FETCH', { fetch_type: 'MONTH_YEAR', month: '0', year: '0' });
  assert.deepEqual(res.params, { fetch_type: 'MONTH_YEAR', month: now.getMonth() + 1, year: now.getFullYear() });
});

test('mailer sends the month folder as a zip to me, the accountant or another address', () => {
  const gas = createGas({ threads: marchThreads() });
  gas.post('FETCH', fetchMarch);
  gas.find('2025', MARCH).createFile('logger.zip', 'old zip');

  const target = { parent_folder: '2025', child_folder: MARCH };

  const me = gas.post('MAILER_EXECUTE', { ...target, mail_to: 'USER' });
  assert.equal(me.ok, true, me.error);
  assert.equal(me.return_value.mode, 'attachment');
  assert.equal(me.return_value.files, 3);

  assert.equal(gas.post('MAILER_EXECUTE', { ...target, mail_to: 'ACCOUNTANT' }).ok, true);
  assert.equal(gas.post('MAILER_EXECUTE', { ...target, mail_to: 'someone@else.example' }).ok, true);

  assert.deepEqual(gas.sent.map((m) => m.to), ['me@example.com', 'accountant@example.com', 'someone@else.example']);
  assert.equal(gas.sent[0].subject, MARCH);
  assert.equal(gas.sent[0].attachments[0].name, MARCH + '.zip');

  const zipped = JSON.parse(gas.sent[0].attachments[0].text.replace('FAKEZIP', '')).map((f) => f.name).sort();
  assert.deepEqual(zipped, [
    `${MARCH}/acc@firm.example/Μάρτιος_p1.pdf`,
    `${MARCH}/billing@dei.example/Μάρτιος_dei-march.pdf`,
    `${MARCH}/shop@store.example/Μάρτιος_Invoice_123.pdf`,
  ]);
});

test('mailer on a missing folder fails and creates nothing', () => {
  const gas = createGas({ threads: marchThreads() });
  gas.post('FETCH', fetchMarch);
  const before = JSON.stringify(gas.dump());

  const res = gas.post('MAILER_EXECUTE', { parent_folder: '2025', child_folder: 'Τιμολόγια_Μάιος_2025', mail_to: 'USER' });
  assert.equal(res.ok, false);
  assert.match(res.error, /was not found/);
  assert.match(gas.post('REMOVE_ARCHIVES', { parent_folder: '2019', child_folder: 'x' }).error, /was not found/);
  assert.match(gas.post('REMOVE_ZIP_FILES', { parent_folder: '2025', child_folder: 'x' }).error, /was not found/);

  const after = gas.dump();
  delete after['logger.log'];
  assert.equal(JSON.stringify(after), before);
  assert.equal(gas.sent.length, 0);
});

test('fetch and inspect mails every month folder that matched to me', () => {
  const gas = createGas({ threads: marchThreads() });
  const res = gas.post('FETCH_N_INSPECT', fetchMarch);

  assert.equal(res.ok, true, res.error);
  assert.equal(res.return_value.saved.length, 3);
  assert.deepEqual(res.return_value.mailed.map((m) => [m.child_folder, m.mail_to, m.mode]), [[MARCH, 'me@example.com', 'attachment']]);
  assert.equal(gas.sent.length, 1);

  // nothing found: nothing mailed, no error
  const empty = gas.post('FETCH_N_INSPECT', { fetch_type: 'MONTH_YEAR', month: 1, year: 2024 });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.return_value.mailed, []);
  assert.equal(gas.sent.length, 1);
});

test('directory structure lists year folders and the legacy NEWER_THAN folder', () => {
  const gas = createGas({ threads: marchThreads() });
  gas.post('FETCH', fetchMarch);
  gas.root.createFolder('NEWER_THAN').createFolder('Τιμολόγια_1/03/2025-11/03/2025');
  gas.root.createFolder('some other folder').createFolder('x');
  gas.root.createFolder('2024');

  const res = gas.post('FETCH_DIR_STRUCTURE', { month: '0', year: '0', newer_than: '', fetch_type: '', action: 'MAILER' });
  assert.equal(res.params.action, 'MAILER');
  assert.deepEqual(res.return_value, {
    2024: [],
    2025: [MARCH],
    NEWER_THAN: ['Τιμολόγια_1/03/2025-11/03/2025'],
  });
});

test('list and download return the stored files, and only files inside the archive', () => {
  const gas = createGas({ threads: marchThreads() });
  gas.post('FETCH', fetchMarch);
  gas.find('2025', MARCH).createFile('old.zip', 'zip');

  const list = gas.post('LIST_FILES', { parent_folder: '2025', child_folder: MARCH }).return_value;
  assert.equal(list.files.length, 3);
  assert.deepEqual(list.zips.map((z) => z.name), ['old.zip']);
  assert.deepEqual(list.files.map((f) => f.sender).sort(), ['acc@firm.example', 'billing@dei.example', 'shop@store.example']);

  const wanted = list.files.find((f) => f.name === 'Μάρτιος_Invoice_123.pdf');
  const outside = gas.drive.myDrive.createFile('private.txt', 'secret');

  const res = gas.post('GET_FILES', { ids: [wanted.id, outside.getId(), 'file_does_not_exist'] }).return_value;
  assert.equal(res.files.length, 1);
  assert.equal(Buffer.compare(Buffer.from(res.files[0].data, 'base64'), pdfB), 0);
  assert.deepEqual(res.errors.map((e) => e.id), [outside.getId(), 'file_does_not_exist']);
  assert.match(res.errors[0].error, /not part of the invoice archive/);
  assert.deepEqual(res.remaining, []);
});

test('download caps the response size and hands back the IDs that did not fit', () => {
  const gas = createGas();
  const folder = gas.root.createFolder('2025').createFolder(MARCH).createFolder('big@x.example');
  const big = Buffer.alloc(8 * 1024 * 1024, 1);
  const ids = ['a.pdf', 'b.pdf', 'c.pdf'].map((name) => {
    const f = folder.createFile(name, '');
    f.bytes = big;
    return f.getId();
  });

  const first = gas.post('GET_FILES', { ids }).return_value;
  assert.deepEqual(first.files.map((f) => f.id), [ids[0]]);
  assert.deepEqual(first.remaining, [ids[1], ids[2]]);
  assert.equal(first.files[0].size, big.length);
});

test('remove zip files trashes only the zips of that folder', () => {
  const gas = createGas({ threads: marchThreads() });
  gas.post('FETCH', fetchMarch);
  const month = gas.find('2025', MARCH);
  month.createFile('one.zip', 'z');
  month.createFile('TWO.ZIP', 'z');

  const res = gas.post('REMOVE_ZIP_FILES', { parent_folder: '2025', child_folder: MARCH });
  assert.deepEqual(res.return_value, { removed: 2 });
  assert.deepEqual(Object.keys(gas.dump()['2025'][MARCH]).sort(), ['acc@firm.example', 'billing@dei.example', 'shop@store.example']);
  assert.deepEqual(gas.post('REMOVE_ZIP_FILES', { parent_folder: '2025', child_folder: MARCH }).return_value, { removed: 0 });
});

test('remove archive trashes the month folder, and a later fetch starts a clean one', () => {
  const gas = createGas({ threads: marchThreads() });
  gas.post('FETCH', fetchMarch);
  gas.post('FETCH', { fetch_type: 'MONTH_YEAR', month: 4, year: 2025 });

  const res = gas.post('REMOVE_ARCHIVES', { parent_folder: '2025', child_folder: MARCH });
  assert.deepEqual(res.return_value, { removed: true });
  assert.deepEqual(gas.post('FETCH_DIR_STRUCTURE', {}).return_value, { 2025: [APRIL] });
  assert.equal(gas.post('REMOVE_ARCHIVES', { parent_folder: '2025', child_folder: MARCH }).ok, false);

  const again = gas.post('FETCH', fetchMarch).return_value;
  assert.equal(again.saved.length, 3);
  assert.equal(again.existing.length, 0);
  assert.equal(Object.keys(gas.dump()['2025'][MARCH]).length, 3);
});

test('legacy NEWER_THAN folders with slashes in the name can be mailed and removed', () => {
  const gas = createGas();
  const name = 'Τιμολόγια_1/03/2025-11/03/2025';
  gas.root.createFolder('NEWER_THAN').createFolder(name).createFolder('a@x.example').createFile('Μάρτιος_x.pdf', 'pdf');

  const mail = gas.post('MAILER_EXECUTE', { parent_folder: 'NEWER_THAN', child_folder: name, mail_to: 'USER' });
  assert.equal(mail.ok, true, mail.error);
  assert.equal(gas.sent[0].attachments[0].name, 'Τιμολόγια_1-03-2025-11-03-2025.zip');
  assert.equal(gas.post('REMOVE_ARCHIVES', { parent_folder: 'NEWER_THAN', child_folder: name }).ok, true);
  assert.deepEqual(gas.post('FETCH_DIR_STRUCTURE', {}).return_value, { NEWER_THAN: [] });
});

test('a root folder ID that stopped working falls back to the folder name, without duplicates', () => {
  const gas = createGas({ threads: marchThreads(), rootFolderId: false });
  assert.equal(gas.post('FETCH', fetchMarch).ok, true);
  gas.post('FETCH_DIR_STRUCTURE', {});

  assert.equal(gas.drive.myDrive.folders.length, 1);
  assert.equal(gas.properties.get('ROOT_FOLDER_ID'), gas.root.getId());
  assert.equal(Object.keys(gas.dump()['2025'][MARCH]).length, 3);
});

test('errors are written to a capped log file', () => {
  const gas = createGas();
  for (let i = 0; i < 5; i++) gas.post('MAILER_EXECUTE', { parent_folder: '2025', child_folder: 'x'.repeat(200), mail_to: 'USER' });
  const log = gas.find('logger.log');
  assert.ok(log, 'logger.log exists');
  assert.match(log.getBlob().getDataAsString(), /was not found/);
  assert.ok(log.getSize() < 250000);
  assert.equal(gas.root.files.filter((f) => f.name === 'logger.log').length, 1);
});

test('folder lookups are cached during a fetch', () => {
  const threads = [];
  for (let i = 0; i < 30; i++) {
    threads.push({ messages: [{ subject: 'Invoice ' + i, from: 'a@x.example', date: new Date(2025, 2, 1 + (i % 28), 10), attachments: [{ name: `inv-${i}.pdf`, bytes: makePdf(['n' + i]) }] }] });
  }
  const gas = createGas({ threads });
  const before = gas.drive.calls;
  assert.equal(gas.post('FETCH', fetchMarch).return_value.saved.length, 30);
  // 30 creates + a handful of lookups, instead of several lookups per invoice
  assert.ok(gas.drive.calls - before < 45, 'drive calls: ' + (gas.drive.calls - before));
});

test('gmail search is paged', () => {
  const threads = [];
  for (let i = 0; i < 230; i++) {
    threads.push({ messages: [{ subject: 'Invoice', from: `s${i}@x.example`, date: new Date(2025, 2, 10, 10), attachments: [{ name: `inv-${i}.pdf`, bytes: pdfA }] }] });
  }
  const gas = createGas({ threads });
  assert.equal(gas.post('FETCH', fetchMarch).return_value.saved.length, 230);
  assert.equal(gas.queries.length, 3);
});
