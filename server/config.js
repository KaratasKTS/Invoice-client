'use strict';
// All settings live in one file, config.json, next to the start scripts:
//
//   url              address of the Apps Script web app
//   key              the secret shared with the script (API_SECRET)
//   accountantEmail  where "send to my accountant" goes
//   port             port of the local page
//   archiveDir       where the invoices are saved
//
// The file holds the key, so it is gitignored and written for this user only.
// url, key and accountantEmail can be changed from the Settings screen.

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..');
const DEFAULTS = Object.freeze({ url: '', key: '', accountantEmail: '', port: 4780, archiveDir: 'archives' });
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsError';
  }
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch (err) {
    throw new SettingsError(`Το αρχείο ρυθμίσεων ${file} δεν διαβάζεται (${err.message}). Διόρθωσέ το ή σβήσε το για να δημιουργηθεί ξανά.`);
  }
}

class Settings {
  /**
   * @param {{file?: string, env?: object, rootDir?: string}} options
   *   file: path of the settings file (default: INVOICE_CONFIG, or config.json in the project folder)
   */
  constructor({ file, env = process.env, rootDir = ROOT_DIR } = {}) {
    this.rootDir = rootDir;
    this.env = env;
    this.file = path.resolve(rootDir, file || env.INVOICE_CONFIG || 'config.json');
    this.notices = [];
    this.values = this._load();
  }

  _load() {
    const dir = path.dirname(this.file);
    const exists = fs.existsSync(this.file);
    const template = path.join(dir, 'config.example.json');

    let stored = {};
    if (exists) stored = readJson(this.file);
    else if (fs.existsSync(template)) stored = readJson(template);

    const values = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof stored[key] === typeof DEFAULTS[key]) values[key] = stored[key];
    }

    // Earlier versions kept the key in its own file. Bring it in once.
    let imported = false;
    const legacyKey = path.join(dir, 'key');
    if (!values.key && fs.existsSync(legacyKey)) {
      const key = fs.readFileSync(legacyKey, 'utf8').replace(/[\r\n]/g, '').trim();
      if (key) {
        values.key = key;
        imported = true;
        this.notices.push(`Ο μυστικός κωδικός μεταφέρθηκε από το αρχείο "key" στο ${path.basename(this.file)}. Το αρχείο "key" δεν χρειάζεται πια.`);
      }
    }

    if (!exists || imported) this._write(values);
    return values;
  }

  _write(values) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(values, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  get url() { return this.values.url; }
  get key() { return this.values.key || null; }
  get accountantEmail() { return this.values.accountantEmail; }

  get port() {
    const raw = this.env.INVOICE_PORT !== undefined && this.env.INVOICE_PORT !== '' ? this.env.INVOICE_PORT : this.values.port;
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new SettingsError('Η θύρα (port) στις ρυθμίσεις πρέπει να είναι αριθμός από 1 έως 65535.');
    return port;
  }

  get archiveDir() {
    return path.resolve(this.rootDir, this.env.INVOICE_ARCHIVE_DIR || this.values.archiveDir);
  }

  /** What the page may see. The key itself never leaves the server. */
  publicView() {
    return {
      url: this.values.url,
      accountantEmail: this.values.accountantEmail,
      hasKey: !!this.values.key,
      archiveDir: this.archiveDir,
      file: this.file,
    };
  }

  /**
   * Changes url, accountantEmail and/or key and saves the file.
   * An empty or missing key leaves the stored key as it is.
   */
  update(patch) {
    const next = { ...this.values };

    if (patch.url !== undefined) {
      const url = String(patch.url).trim();
      if (url !== '') {
        let parsed;
        try { parsed = new URL(url); } catch (err) { parsed = null; }
        if (!parsed || !/^https?:$/.test(parsed.protocol)) {
          throw new SettingsError('Η διεύθυνση της υπηρεσίας δεν είναι έγκυρη. Πρέπει να μοιάζει με https://script.google.com/macros/s/…/exec');
        }
      }
      next.url = url;
    }

    if (patch.accountantEmail !== undefined) {
      const email = String(patch.accountantEmail).trim();
      if (email !== '' && !EMAIL_PATTERN.test(email)) {
        throw new SettingsError('Το email του λογιστή δεν είναι έγκυρο. Πρέπει να μοιάζει με onoma@example.com');
      }
      next.accountantEmail = email;
    }

    if (patch.key !== undefined && patch.key !== null) {
      const key = String(patch.key).replace(/[\r\n]/g, '').trim();
      if (key !== '') next.key = key;
    }

    this._write(next);
    this.values = next;
    return this.publicView();
  }
}

module.exports = { Settings, SettingsError, ROOT_DIR, EMAIL_PATTERN };
