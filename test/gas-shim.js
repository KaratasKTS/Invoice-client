'use strict';
// Fake Google Apps Script services, enough to run backend/*.gs under Node.
// The fakes keep Drive's awkward habits on purpose: getFiles()/getFolders()
// still return trashed items, and Gmail search returns whole threads.

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BACKEND_DIR = path.join(__dirname, '..', 'backend');

function toSigned(buffer) {
  return Array.from(buffer, (b) => (b > 127 ? b - 256 : b));
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
  return Buffer.from(Array.from(bytes, (b) => b & 0xff));
}

function iterator(items) {
  let i = 0;
  return {
    hasNext: () => i < items.length,
    next: () => {
      if (i >= items.length) throw new Error('Iterator has no more items');
      return items[i++];
    },
  };
}

class FakeBlob {
  constructor(bytes, name, contentType) {
    this._bytes = toBuffer(bytes);
    this._name = name;
    this._contentType = contentType || 'application/octet-stream';
  }
  getBytes() { return toSigned(this._bytes); }
  getName() { return this._name; }
  setName(name) { this._name = name; return this; }
  getContentType() { return this._contentType; }
  setContentType(type) { this._contentType = type; return this; }
  copyBlob() { return new FakeBlob(this._bytes, this._name, this._contentType); }
  getDataAsString() { return this._bytes.toString('utf8'); }
}

class FakeAttachment extends FakeBlob {
  constructor(bytes, name, contentType, reportedSize) {
    super(bytes, name, contentType);
    this._reportedSize = reportedSize;
  }
  getSize() { return this._reportedSize === undefined ? this._bytes.length : this._reportedSize; }
}

// Supports the two clauses the backend uses: trashed = false, title = '...'
function parseQuery(query) {
  const filters = [];
  let rest = String(query).trim();
  while (rest.length) {
    let m;
    if ((m = rest.match(/^trashed = false/))) {
      filters.push((item) => !item.isTrashed());
    } else if ((m = rest.match(/^title = '((?:[^'\\]|\\.)*)'/))) {
      const title = m[1].replace(/\\(.)/g, '$1');
      filters.push((item) => item.getName() === title);
    } else {
      throw new Error('Fake Drive: unsupported query: ' + query);
    }
    rest = rest.slice(m[0].length).trim();
    if (rest.startsWith('and ')) rest = rest.slice(4).trim();
    else if (rest.length) throw new Error('Fake Drive: unsupported query: ' + query);
  }
  return (item) => filters.every((f) => f(item));
}

class FakeDrive {
  constructor() {
    this.items = new Map();
    this.counter = 0;
    this.calls = 0;
    this.myDrive = new FakeFolder(this, 'My Drive', null);
  }
  newId(kind) {
    this.counter += 1;
    return `${kind}_${String(this.counter).padStart(6, '0')}_${crypto.randomBytes(6).toString('hex')}`;
  }
}

class FakeItem {
  constructor(drive, name, parent, kind) {
    this.drive = drive;
    this.name = name;
    this.parent = parent;
    this.trashed = false;
    this.id = drive.newId(kind);
    drive.items.set(this.id, this);
  }
  getName() { return this.name; }
  getId() { return this.id; }
  getParents() { return iterator(this.parent ? [this.parent] : []); }
  setTrashed(value) { this.trashed = !!value; return this; }
  isTrashed() {
    for (let item = this; item; item = item.parent) if (item.trashed) return true;
    return false;
  }
}

class FakeFolder extends FakeItem {
  constructor(drive, name, parent) {
    super(drive, name, parent, 'folder');
    this.folders = [];
    this.files = [];
  }
  getFolders() { this.drive.calls++; return iterator(this.folders.slice()); }
  getFiles() { this.drive.calls++; return iterator(this.files.slice()); }
  getFoldersByName(name) { this.drive.calls++; return iterator(this.folders.filter((f) => f.name === name)); }
  getFilesByName(name) { this.drive.calls++; return iterator(this.files.filter((f) => f.name === name)); }
  searchFolders(query) { this.drive.calls++; return iterator(this.folders.filter(parseQuery(query))); }
  searchFiles(query) { this.drive.calls++; return iterator(this.files.filter(parseQuery(query))); }
  createFolder(name) {
    this.drive.calls++;
    const folder = new FakeFolder(this.drive, name, this);
    this.folders.push(folder);
    return folder;
  }
  createFile(blobOrName, content) {
    this.drive.calls++;
    const file = typeof blobOrName === 'string'
      ? new FakeFile(this.drive, blobOrName, this, Buffer.from(content || '', 'utf8'), 'text/plain')
      : new FakeFile(this.drive, blobOrName.getName(), this, blobOrName._bytes, blobOrName.getContentType());
    this.files.push(file);
    return file;
  }
}

class FakeFile extends FakeItem {
  constructor(drive, name, parent, bytes, contentType) {
    super(drive, name, parent, 'file');
    this.bytes = Buffer.from(bytes);
    this.contentType = contentType;
    this.viewers = [];
  }
  getSize() { return this.bytes.length; }
  getBlob() { return new FakeBlob(this.bytes, this.name, this.contentType); }
  setContent(text) { this.bytes = Buffer.from(String(text), 'utf8'); return this; }
  addViewer(email) { this.viewers.push(email); return this; }
  getUrl() { return 'https://drive.example/file/' + this.id; }
}

class FakeThread {
  constructor(spec) {
    this.messages = spec.messages.map((m) => new FakeMessage(m));
    this.subject = spec.subject !== undefined ? spec.subject : this.messages[0].subject;
  }
  getFirstMessageSubject() { return this.subject; }
  getMessages() { return this.messages; }
}

class FakeMessage {
  constructor(spec) {
    this.subject = spec.subject || '';
    this.from = spec.from || '';
    this.date = new Date(spec.date);
    this.attachments = (spec.attachments || []).map(
      (a) => new FakeAttachment(a.bytes, a.name, a.contentType || 'application/pdf', a.reportedSize));
  }
  getSubject() { return this.subject; }
  getFrom() { return this.from; }
  getDate() { return new Date(this.date); }
  getAttachments() { return this.attachments; }
}

/**
 * Loads the backend into a fresh sandbox.
 * options: { secret, mailList, threads, rootFolderId (false = configured ID is not accessible) }
 */
function createGas(options = {}) {
  const secret = options.secret === undefined ? 'test-secret' : options.secret;
  const drive = new FakeDrive();
  const root = drive.myDrive.createFolder('dataccent-invoice-mail');
  const threads = (options.threads || []).map((t) => new FakeThread(t));
  const sent = [];
  const queries = [];
  const logs = [];
  const properties = new Map();
  if (secret) properties.set('API_SECRET', secret);

  const config = {
    ROOT_FOLDER_ID: options.rootFolderId === false ? 'missing_folder_id' : root.getId(),
    ROOT_FOLDER_NAME: 'dataccent-invoice-mail',
    MAIL_LIST: options.mailList || { USER: 'me@example.com', ACCOUNTANT: 'accountant@example.com' },
  };

  const sandbox = {
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
    Logger: { log: (...a) => logs.push(a.join(' ')) },
    MimeType: { PDF: 'application/pdf' },
    getConfig_: () => config,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (properties.has(k) ? properties.get(k) : null),
        setProperty: (k, v) => { properties.set(k, String(v)); },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
      createTextOutput: (text) => ({
        text,
        mime: 'TEXT',
        setMimeType(m) { this.mime = m; return this; },
        getContent() { return this.text; },
      }),
    },
    Utilities: {
      Charset: { UTF_8: 'UTF_8' },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeHmacSha256Signature: (value, key) =>
        toSigned(crypto.createHmac('sha256', key).update(value, 'utf8').digest()),
      computeDigest: (alg, bytes) => toSigned(crypto.createHash('sha256').update(toBuffer(bytes)).digest()),
      base64Encode: (bytes) => toBuffer(bytes).toString('base64'),
      zip: (blobs, name) => {
        const names = blobs.map((b) => b.getName());
        if (new Set(names).size !== names.length) throw new Error('Fake zip: duplicate file names');
        const listing = blobs.map((b) => ({ name: b.getName(), size: b._bytes.length }));
        return new FakeBlob(Buffer.from('FAKEZIP' + JSON.stringify(listing)), name || 'archive.zip', 'application/zip');
      },
    },
    DriveApp: {
      getFolderById: (id) => {
        const item = drive.items.get(id);
        if (!(item instanceof FakeFolder)) throw new Error('No item with the given ID could be found');
        return item;
      },
      getFileById: (id) => {
        const item = drive.items.get(id);
        if (!(item instanceof FakeFile)) throw new Error('No item with the given ID could be found');
        return item;
      },
      searchFolders: (query) => {
        const match = parseQuery(query);
        return iterator([...drive.items.values()].filter((i) => i instanceof FakeFolder && i !== drive.myDrive && match(i)));
      },
      createFolder: (name) => drive.myDrive.createFolder(name),
    },
    GmailApp: {
      search: (query, start = 0, max = 500) => {
        queries.push(query);
        const after = Number((query.match(/after:(\d+)/) || [])[1] || 0) * 1000;
        const before = Number((query.match(/before:(\d+)/) || [])[1] || 1e12) * 1000;
        const hits = threads.filter((t) => t.messages.some((m) => m.date.getTime() > after && m.date.getTime() < before));
        return hits.slice(start, start + max);
      },
      getMessagesForThreads: (list) => list.map((t) => t.getMessages()),
      sendEmail: (to, subject, body, opts) => {
        if (!to) throw new Error('Failed to send email: no recipient');
        sent.push({
          to, subject, body,
          attachments: ((opts && opts.attachments) || []).map((b) => ({ name: b.getName(), size: b._bytes.length, text: b.getDataAsString() })),
        });
      },
    },
  };

  const context = vm.createContext(sandbox);
  for (const file of ['api.gs', 'Code.gs']) {
    const source = fs.readFileSync(path.join(BACKEND_DIR, file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }

  function sign(ts, execType, body, key = secret) {
    return crypto.createHmac('sha256', key).update(`${ts}.${execType}.${body}`, 'utf8').digest('hex');
  }

  /** Calls doPost the way the web app would. `raw` overrides ts, sig or body. */
  function post(execType, params, raw = {}) {
    const body = raw.body !== undefined ? raw.body : JSON.stringify(params === undefined ? {} : params);
    const ts = raw.ts !== undefined ? raw.ts : String(Math.floor(Date.now() / 1000));
    const sig = raw.sig !== undefined ? raw.sig : sign(ts, execType, body);
    return handle({ ts, sig, exec_type: execType }, body);
  }

  /** Runs doPost with a raw query object and body, returns the parsed JSON response. */
  function handle(query, body) {
    const output = context.doPost({ postData: { contents: body }, parameter: query });
    return JSON.parse(output.getContent());
  }

  /** Path-based lookup in the fake Drive, e.g. find('2026', 'Τιμολόγια_…', 'a@b.c') */
  function find(...names) {
    let node = root;
    for (const name of names) {
      const next = node.folders.concat(node.files).find((c) => c.name === name && !c.isTrashed());
      if (!next) return null;
      node = next;
    }
    return node;
  }

  /** Plain-object dump of the live (non-trashed) tree under a folder. */
  function dump(folder = root) {
    const out = {};
    folder.folders.filter((f) => !f.isTrashed()).forEach((f) => { out[f.name] = dump(f); });
    folder.files.filter((f) => !f.isTrashed()).forEach((f) => { out[f.name] = f.getSize(); });
    return out;
  }

  return { context, drive, root, threads, sent, queries, logs, properties, post, handle, sign, find, dump, secret };
}

/** A small valid one-page PDF with the given lines of ASCII text. */
function makePdf(lines) {
  const esc = (s) => String(s).replace(/[\\()]/g, '\\$&');
  const text = lines.map((l, i) => `${i === 0 ? '72 760 Td' : '0 -26 Td'} (${esc(l)}) Tj`).join(' ');
  const stream = `BT /F1 16 Tf ${text} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { pdf += `${String(o).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

module.exports = { createGas, makePdf, FakeFolder, FakeFile };
