'use strict';
// What the client can do, built on the backend actions and the local archive.

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOWNLOAD_BATCH = 40;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

// ---- input checks ---------------------------------------------------------

function checkFolder(input) {
  const parent = input && input.parent_folder;
  const child = input && input.child_folder;
  for (const value of [parent, child]) {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 255) throw new InputError('A folder is required');
  }
  return { parent_folder: parent, child_folder: child };
}

function checkFetch(input) {
  const inspect = !!(input && input.inspect);

  if (input && input.mode === 'newer_than') {
    const days = Number(input.newer_than);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new InputError('Days must be a whole number from 1 to 90');
    return { inspect, targets: [{ label: `the last ${days} day${days === 1 ? '' : 's'}`, params: { fetch_type: 'NEWER_THAN', newer_than: days } }] };
  }

  if (input && input.mode === 'months') {
    const months = input.months;
    const currentYear = new Date().getFullYear();
    if (!Array.isArray(months) || months.length === 0 || months.length > 36) throw new InputError('Choose at least one month');

    const seen = new Set();
    const targets = [];
    for (const item of months) {
      const month = Number(item && item.month);
      const year = Number(item && item.year);
      if (!Number.isInteger(month) || month < 1 || month > 12) throw new InputError('Month must be 1-12');
      if (!Number.isInteger(year) || year < 2000 || year > currentYear) throw new InputError(`Year must be between 2000 and ${currentYear}`);
      const key = `${year}-${month}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ label: `${MONTH_NAMES[month - 1]} ${year}`, params: { fetch_type: 'MONTH_YEAR', month, year } });
    }
    targets.sort((a, b) => (a.params.year - b.params.year) || (a.params.month - b.params.month));
    return { inspect, targets };
  }

  throw new InputError('Choose months or a number of days');
}

function checkMailTo(value) {
  if (value === 'USER' || value === 'ACCOUNTANT') return value;
  if (typeof value === 'string' && EMAIL_PATTERN.test(value)) return value;
  throw new InputError('Enter a valid email address');
}

// ---- operations -----------------------------------------------------------

/** Errors that will hit every request the same way: no key, no URL, no connection, wrong key. */
function isFatal(err) {
  return ['NO_KEY', 'NO_URL', 'NETWORK', 'BAD_RESPONSE'].includes(err.code) || /^Invalid signature/.test(err.message);
}

function createOperations({ backend, store }) {

  /** Downloads the files that are not on disk yet. Returns counts and failures. */
  async function downloadMissing(files, ctx) {
    const byId = new Map(files.map((f) => [f.id, f]));
    const missing = files.filter((f) => !store.hasFile(f));
    const failed = [];
    let queue = missing.map((f) => f.id);
    let downloaded = 0;

    try {
      while (queue.length) {
        const batch = queue.slice(0, DOWNLOAD_BATCH);
        queue = queue.slice(DOWNLOAD_BATCH);

        const res = await backend.call('GET_FILES', { ids: batch });
        const got = res.files || [];
        const errors = res.errors || [];
        const remaining = res.remaining || [];

        for (const file of got) {
          const record = byId.get(file.id);
          if (!record) continue;
          store.saveFile(record, Buffer.from(file.data, 'base64'));
          downloaded++;
        }
        for (const err of errors) {
          const record = byId.get(err.id);
          failed.push({ name: record ? record.name : err.id, error: err.error });
          ctx.log(`Could not download ${record ? record.name : err.id}: ${err.error}`, 'error');
        }

        if (got.length === 0 && errors.length === 0 && remaining.length) {
          throw new Error('The backend returned no files for a download request');
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

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      ctx.progress(i, targets.length);
      ctx.log(`Fetching ${target.label}…`);

      try {
        const res = await backend.call(inspect ? 'FETCH_N_INSPECT' : 'FETCH', target.params);
        const files = (res.saved || []).concat(res.existing || []);

        totals.saved += (res.saved || []).length;
        totals.existing += (res.existing || []).length;
        totals.mailed += (res.mailed || []).length;

        for (const file of files) {
          const rel = store.registerFolder(file.parent_folder, file.child_folder);
          if (!totals.folders.includes(rel)) totals.folders.push(rel);
        }

        if (files.length === 0) {
          ctx.log(`${target.label}: no invoices found.`);
          continue;
        }

        ctx.log(`${target.label}: ${(res.saved || []).length} new in Drive, ${(res.existing || []).length} already there.`);
        for (const mail of res.mailed || []) ctx.log(`Emailed ${mail.child_folder} to ${mail.mail_to}.`);

        const result = await downloadMissing(files, ctx);
        totals.downloaded += result.downloaded;
        totals.failed.push(...result.failed);
        ctx.log(`${target.label}: ${result.downloaded} file${result.downloaded === 1 ? '' : 's'} saved to this computer.`);
      } catch (err) {
        totals.errors.push({ target: target.label, error: err.message });
        ctx.log(`${target.label}: ${err.message}`, 'error');
        // No point trying the rest when the backend cannot be reached at all.
        if (isFatal(err)) throw err;
      }
    }

    ctx.progress(targets.length, targets.length);

    if (totals.errors.length === targets.length) throw new Error(totals.errors[0].error);
    return totals;
  }

  /** Drive -> disk for the given month folders, or for every folder in Drive. */
  async function syncFromDrive(input, ctx) {
    let folders;
    if (input && Array.isArray(input.folders) && input.folders.length) {
      folders = input.folders.map(checkFolder);
    } else {
      ctx.log('Reading the folder list from Drive…');
      const structure = await backend.call('FETCH_DIR_STRUCTURE', { action: '' });
      folders = [];
      for (const parent of Object.keys(structure).sort()) {
        for (const child of structure[parent]) folders.push({ parent_folder: parent, child_folder: child });
      }
    }

    const totals = { folders: [], downloaded: 0, alreadyLocal: 0, failed: [], errors: [] };

    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      ctx.progress(i, folders.length);

      try {
        const list = await backend.call('LIST_FILES', folder);
        const rel = store.registerFolder(folder.parent_folder, folder.child_folder);
        totals.folders.push(rel);

        const result = await downloadMissing(list.files || [], ctx);
        totals.downloaded += result.downloaded;
        totals.alreadyLocal += result.alreadyLocal;
        totals.failed.push(...result.failed);
        ctx.log(`${folder.child_folder}: ${result.downloaded} downloaded, ${result.alreadyLocal} already here.`);
      } catch (err) {
        totals.errors.push({ target: folder.child_folder, error: err.message });
        ctx.log(`${folder.child_folder}: ${err.message}`, 'error');
        // No point trying the rest when the backend cannot be reached at all.
        if (isFatal(err)) throw err;
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

  function mailFolder(input) {
    const folder = checkFolder(input);
    return backend.call('MAILER_EXECUTE', { ...folder, mail_to: checkMailTo(input.mail_to) });
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

  return { fetchInvoices, syncFromDrive, remoteStructure, mailFolder, removeZipFiles, removeArchive, deleteLocal, downloadMissing };
}

module.exports = { createOperations, InputError, checkFetch, checkFolder, checkMailTo };
