'use strict';
// What the client can do, built on the backend actions and the local archive.
// Messages are shown to the user, so they are in Greek.

const { EMAIL_PATTERN } = require('./config.js');

const MONTH_NAMES = ['Ιανουάριος', 'Φεβρουάριος', 'Μάρτιος', 'Απρίλιος', 'Μάιος', 'Ιούνιος',
  'Ιούλιος', 'Αύγουστος', 'Σεπτέμβριος', 'Οκτώβριος', 'Νοέμβριος', 'Δεκέμβριος'];
const DOWNLOAD_BATCH = 40;

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

/** "3 αρχεία" / "1 αρχείο" */
function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Τιμολόγια_Νοέμβριος_2026" -> "Νοέμβριος 2026" */
function folderLabel(childFolder) {
  return String(childFolder).replace(/^Τιμολόγια_/, '').replace(/_/g, ' ');
}

// ---- input checks ---------------------------------------------------------

function checkFolder(input) {
  const parent = input && input.parent_folder;
  const child = input && input.child_folder;
  for (const value of [parent, child]) {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 255) throw new InputError('Δεν επιλέχθηκε φάκελος.');
  }
  return { parent_folder: parent, child_folder: child };
}

function checkFetch(input) {
  const inspect = !!(input && input.inspect);

  if (input && input.mode === 'newer_than') {
    const days = Number(input.newer_than);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new InputError('Οι ημέρες πρέπει να είναι ακέραιος αριθμός από 1 έως 90.');
    const label = days === 1 ? 'Τελευταία ημέρα' : `Τελευταίες ${days} ημέρες`;
    return { inspect, targets: [{ label, params: { fetch_type: 'NEWER_THAN', newer_than: days } }] };
  }

  if (input && input.mode === 'months') {
    const months = input.months;
    const currentYear = new Date().getFullYear();
    if (!Array.isArray(months) || months.length === 0 || months.length > 36) throw new InputError('Διάλεξε τουλάχιστον έναν μήνα.');

    const seen = new Set();
    const targets = [];
    for (const item of months) {
      const month = Number(item && item.month);
      const year = Number(item && item.year);
      if (!Number.isInteger(month) || month < 1 || month > 12) throw new InputError('Ο μήνας δεν είναι έγκυρος.');
      if (!Number.isInteger(year) || year < 2000 || year > currentYear) throw new InputError(`Το έτος πρέπει να είναι από 2000 έως ${currentYear}.`);
      const key = `${year}-${month}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ label: `${MONTH_NAMES[month - 1]} ${year}`, params: { fetch_type: 'MONTH_YEAR', month, year } });
    }
    targets.sort((a, b) => (a.params.year - b.params.year) || (a.params.month - b.params.month));
    return { inspect, targets };
  }

  throw new InputError('Διάλεξε μήνες ή αριθμό ημερών.');
}

/** Errors that will hit every request the same way: nothing set up, no connection, wrong key. */
function isFatal(err) {
  return ['NO_KEY', 'NO_URL', 'NETWORK', 'BAD_RESPONSE', 'BAD_KEY', 'CLOCK', 'CANCELLED'].includes(err.code);
}

// ---- operations -----------------------------------------------------------

/**
 * @param {{backend: object, store: object, settings: object}} deps
 */
function createOperations({ backend, store, settings }) {

  /** Downloads the files that are not on disk yet. Returns counts and failures. */
  async function downloadMissing(files, ctx) {
    const byId = new Map(files.map((f) => [f.id, f]));
    const missing = files.filter((f) => !store.hasFile(f));
    const failed = [];
    let queue = missing.map((f) => f.id);
    let downloaded = 0;

    try {
      while (queue.length) {
        ctx.checkCancelled();

        const batch = queue.slice(0, DOWNLOAD_BATCH);
        queue = queue.slice(DOWNLOAD_BATCH);

        const res = await backend.call('GET_FILES', { ids: batch }, { signal: ctx.signal });
        const got = res.files || [];
        const errors = res.errors || [];
        const remaining = res.remaining || [];

        for (const file of got) {
          const record = byId.get(file.id);
          if (!record) continue;
          store.saveFile(record, Buffer.from(file.data, 'base64'));
          ctx.downloaded(record.id);
          downloaded++;
        }
        for (const err of errors) {
          const record = byId.get(err.id);
          const name = record ? record.name : err.id;
          failed.push({ name, error: err.error });
          ctx.log(`Το αρχείο ${name} δεν κατέβηκε.`, 'error');
        }

        if (got.length === 0 && errors.length === 0 && remaining.length) {
          throw new Error('Η υπηρεσία δεν έστειλε τα αρχεία που ζητήθηκαν.');
        }

        queue = remaining.concat(queue);
      }
    } finally {
      store.flush();
    }

    return { downloaded, alreadyLocal: files.length - missing.length, failed };
  }

  /** Gmail -> Drive for each target, then Drive -> disk for the files it touched. */
  async function fetchInvoices(input, ctx) {
    const { inspect, targets } = checkFetch(input);
    const totals = { saved: 0, existing: 0, downloaded: 0, mailed: 0, failed: [], errors: [], folders: [] };
    ctx.report(totals);

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      ctx.checkCancelled();
      ctx.progress(i, targets.length);
      ctx.log(`${target.label}: αναζήτηση στο email…`);

      try {
        const res = await backend.call(inspect ? 'FETCH_N_INSPECT' : 'FETCH', target.params, { signal: ctx.signal });
        const saved = res.saved || [];
        const existing = res.existing || [];
        const files = saved.concat(existing);

        totals.saved += saved.length;
        totals.existing += existing.length;
        totals.mailed += (res.mailed || []).length;

        for (const file of files) {
          const rel = store.registerFolder(file.parent_folder, file.child_folder);
          if (!totals.folders.includes(rel)) totals.folders.push(rel);
        }

        if (files.length === 0) {
          ctx.log(`${target.label}: δεν βρέθηκαν τιμολόγια.`);
          continue;
        }

        ctx.log(`${target.label}: ${count(saved.length, 'νέο τιμολόγιο', 'νέα τιμολόγια')}, ${existing.length} υπήρχαν ήδη.`);
        for (const mail of res.mailed || []) ctx.log(`Στάλθηκε email με τον μήνα ${folderLabel(mail.child_folder)} στο ${mail.mail_to}.`);

        const result = await downloadMissing(files, ctx);
        totals.downloaded += result.downloaded;
        totals.failed.push(...result.failed);
        ctx.log(`${target.label}: ${count(result.downloaded, 'αρχείο αποθηκεύτηκε', 'αρχεία αποθηκεύτηκαν')} στον υπολογιστή.`);
      } catch (err) {
        // No point trying the rest when the backend cannot be reached at all, or the user stopped.
        if (isFatal(err)) throw err;
        totals.errors.push({ target: target.label, error: err.message });
        ctx.log(`${target.label}: ${err.message}`, 'error');
      }
    }

    ctx.progress(targets.length, targets.length);

    if (totals.errors.length === targets.length) throw new Error(totals.errors[0].error);
    return totals;
  }

  /** Drive -> disk for the given month folders, or for every folder in Drive. */
  async function syncFromDrive(input, ctx) {
    const totals = { folders: [], downloaded: 0, alreadyLocal: 0, failed: [], errors: [] };
    ctx.report(totals);

    let folders;
    if (input && Array.isArray(input.folders) && input.folders.length) {
      folders = input.folders.map(checkFolder);
    } else {
      ctx.log('Ανάγνωση των φακέλων από το Google Drive…');
      const structure = await backend.call('FETCH_DIR_STRUCTURE', { action: '' }, { signal: ctx.signal });
      folders = [];
      for (const parent of Object.keys(structure).sort()) {
        for (const child of structure[parent]) folders.push({ parent_folder: parent, child_folder: child });
      }
    }

    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      const label = folderLabel(folder.child_folder);
      ctx.checkCancelled();
      ctx.progress(i, folders.length);

      try {
        const list = await backend.call('LIST_FILES', folder, { signal: ctx.signal });
        const rel = store.registerFolder(folder.parent_folder, folder.child_folder);
        totals.folders.push(rel);

        const result = await downloadMissing(list.files || [], ctx);
        totals.downloaded += result.downloaded;
        totals.alreadyLocal += result.alreadyLocal;
        totals.failed.push(...result.failed);
        ctx.log(`${label}: κατέβηκαν ${result.downloaded}, υπήρχαν ήδη ${result.alreadyLocal}.`);
      } catch (err) {
        if (isFatal(err)) throw err;
        totals.errors.push({ target: label, error: err.message });
        ctx.log(`${label}: ${err.message}`, 'error');
      }
    }

    store.flush();
    ctx.progress(folders.length, folders.length);

    if (folders.length && totals.errors.length === folders.length) throw new Error(totals.errors[0].error);
    return totals;
  }

  /** { "<year>": ["<month folder>", ...] } as stored in Drive. */
  function remoteStructure() {
    return backend.call('FETCH_DIR_STRUCTURE', { action: '' });
  }

  /** Checks that the address and the key in Settings reach the script. */
  async function testConnection() {
    const structure = await backend.call('FETCH_DIR_STRUCTURE', { action: '' });
    const folders = Object.values(structure).reduce((sum, list) => sum + list.length, 0);
    return { ok: true, folders };
  }

  /**
   * Emails a month folder. mail_to is USER (the script knows the address),
   * ACCOUNTANT (the address from Settings) or an email address.
   */
  async function mailFolder(input) {
    const folder = checkFolder(input);
    let mailTo = input.mail_to;

    if (mailTo === 'ACCOUNTANT') {
      mailTo = settings.accountantEmail;
      if (!mailTo) throw new InputError('Δεν έχεις ορίσει email λογιστή. Πρόσθεσέ το στις Ρυθμίσεις.');
    } else if (mailTo !== 'USER' && !(typeof mailTo === 'string' && EMAIL_PATTERN.test(mailTo))) {
      throw new InputError('Γράψε μια έγκυρη διεύθυνση email.');
    }

    return backend.call('MAILER_EXECUTE', { ...folder, mail_to: mailTo });
  }

  function removeZipFiles(input) {
    return backend.call('REMOVE_ZIP_FILES', checkFolder(input));
  }

  async function removeArchive(input) {
    const folder = checkFolder(input);
    const result = await backend.call('REMOVE_ARCHIVES', folder);
    const localRemoved = input.delete_local ? store.removeFolder(folder.parent_folder, folder.child_folder) : false;
    return { ...result, localRemoved };
  }

  function deleteLocal(input) {
    const folder = checkFolder(input);
    return { localRemoved: store.removeFolder(folder.parent_folder, folder.child_folder) };
  }

  return { fetchInvoices, syncFromDrive, remoteStructure, testConnection, mailFolder, removeZipFiles, removeArchive, deleteLocal, downloadMissing };
}

module.exports = { createOperations, InputError, checkFetch, checkFolder, folderLabel, count };
