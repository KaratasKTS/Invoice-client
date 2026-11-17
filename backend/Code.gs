// Invoice engine: reads invoice PDFs from Gmail, files them in Drive as
//   <root>/<year>/Τιμολόγια_<month>_<year>/<sender>/<file>
// and mails, lists, serves or removes those archives.
//
// Nothing here runs at load time that depends on another file, so the order of
// the script files in the Apps Script editor does not matter.

const MONTHS = [
  "Ιανουάριος", "Φεβρουάριος",
  "Μάρτιος", "Απρίλιος",
  "Μάιος", "Ιούνιος",
  "Ιούλιος", "Αύγουστος",
  "Σεπτέμβριος", "Οκτώβριος",
  "Νοέμβριος", "Δεκέμβριος"
];

const MAIL_TO = Object.freeze({
  USER: "USER",
  ACCOUNTANT: "ACCOUNTANT",
});

const ACTIONS = Object.freeze({
  FETCH: "FETCH",
  FETCH_N_INSPECT: "FETCH_N_INSPECT",
  REMOVE_ZIP_FILES: "REMOVE_ZIP_FILES",
  REMOVE_ARCHIVES: "REMOVE_ARCHIVES",
  FETCH_DIR_STRUCTURE: "FETCH_DIR_STRUCTURE",
  MAILER_EXECUTE: "MAILER_EXECUTE",
  MAILER: "MAILER",
  LIST_FILES: "LIST_FILES",
  GET_FILES: "GET_FILES"
});

const FETCH_TYPE = Object.freeze({
  NEWER_THAN: "NEWER_THAN",
  MONTH_YEAR: "MONTH_YEAR",
});

// Older versions saved "newer than" fetches under this folder. It is still
// listed, mailed and removable, but nothing new is written to it.
const LEGACY_NEWER_THAN_FOLDER = "NEWER_THAN";

const SEARCH_TERMS = ['τιμολογ', 'invoice', 'παραστατ'];

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const MAX_MAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;        // per GET_FILES response, before base64
const MAX_DOWNLOAD_FILE_BYTES = 30 * 1024 * 1024;   // a single file larger than this is refused
const MAX_DOWNLOAD_IDS = 200;
const GMAIL_PAGE_SIZE = 100;
const LOG_MAX_CHARS = 200000;
const DAY_MS = 24 * 60 * 60 * 1000;


// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function exec(exec_type, rawParams) {

  let params = rawParams;

  try {

    const handler = getHandler_(exec_type);

    params = validateParams_(exec_type, rawParams);

    return {
      ok: true,
      return_value: handler(params),
      exec_type: exec_type,
      params: params
    };

  } catch (e) {

    const message = (e && e.message) ? String(e.message) : String(e);

    const failure = {
      ok: false,
      error: message,
      return_value: message,
      exec_type: exec_type,
      params: params
    };

    logger(failure);

    return failure;
  }
}


function getHandler_(exec_type) {

  switch (exec_type) {
    case ACTIONS.FETCH: return fetchInvoices;
    case ACTIONS.FETCH_N_INSPECT: return fetchInspectInvoices;
    case ACTIONS.FETCH_DIR_STRUCTURE: return logdirs;
    case ACTIONS.LIST_FILES: return listFiles;
    case ACTIONS.GET_FILES: return getFiles;
    case ACTIONS.MAILER_EXECUTE: return mailExecute;
    case ACTIONS.REMOVE_ZIP_FILES: return removeZipFiles;
    case ACTIONS.REMOVE_ARCHIVES: return removeArchives;
  }

  throw Error('Unknown action "' + exec_type + '"');
}


// Run from the Apps Script editor to check the setup without the HTTP layer.
function debugRun() {
  Logger.log(JSON.stringify(exec(ACTIONS.FETCH_DIR_STRUCTURE, { action: '' }), null, 2));
}


// ---------------------------------------------------------------------------
// Parameter validation (one schema per action)
// ---------------------------------------------------------------------------

function validateParams_(exec_type, raw) {

  if (!isPlainObject(raw)) throw Error('Parameters must be a JSON object');

  const p = {};

  switch (exec_type) {

    case ACTIONS.FETCH:
    case ACTIONS.FETCH_N_INSPECT:
      p.fetch_type = validateFetchType(raw.fetch_type);
      if (p.fetch_type === FETCH_TYPE.MONTH_YEAR) {
        p.month = sanitizeMonth(raw.month);
        p.year = sanitizeYear(raw.year);
      } else {
        p.newer_than = sanitizeNewerThan(raw.newer_than);
      }
      break;

    case ACTIONS.FETCH_DIR_STRUCTURE:
      p.action = validateAction(raw.action);
      break;

    case ACTIONS.MAILER_EXECUTE:
      p.parent_folder = sanitizeFolderName(raw.parent_folder, 'parent_folder');
      p.child_folder = sanitizeFolderName(raw.child_folder, 'child_folder');
      p.mail_to = sanitizeMailTo(raw.mail_to);
      break;

    case ACTIONS.LIST_FILES:
    case ACTIONS.REMOVE_ZIP_FILES:
    case ACTIONS.REMOVE_ARCHIVES:
      p.parent_folder = sanitizeFolderName(raw.parent_folder, 'parent_folder');
      p.child_folder = sanitizeFolderName(raw.child_folder, 'child_folder');
      break;

    case ACTIONS.GET_FILES:
      p.ids = sanitizeIds(raw.ids);
      break;
  }

  return p;
}


function isPlainObject(x) {
  if (x === null || typeof x !== "object") return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}


function isBlank_(value) {
  return value === undefined || value === null || value === '';
}


function validateAction(action) {
  if (isBlank_(action)) return '';
  if (!Object.values(ACTIONS).includes(action)) throw Error('Action "' + action + '" does not exist');
  return action;
}


function validateFetchType(fetchType) {
  if (!Object.values(FETCH_TYPE).includes(fetchType)) {
    throw Error('fetch_type must be NEWER_THAN or MONTH_YEAR');
  }
  return fetchType;
}


// 1-90 days. Returns a number.
function sanitizeNewerThan(newerThan) {
  const n = Number(newerThan);
  if (isBlank_(newerThan) || !Number.isInteger(n) || n < 1 || n > 90) {
    throw Error('newer_than must be a whole number from 1 to 90');
  }
  return n;
}


// 1-12, or 0 / blank for the current month. Returns a number 1-12.
function sanitizeMonth(month) {
  const m = isBlank_(month) ? 0 : Number(month);
  if (!Number.isInteger(m) || m < 0 || m > 12) throw Error('month must be 0-12 (0 = current month)');
  return m === 0 ? new Date().getMonth() + 1 : m;
}


// A year up to the current one, or 0 / blank for the current year. Returns a number.
function sanitizeYear(year) {
  const current = new Date().getFullYear();
  const y = isBlank_(year) ? 0 : Number(year);
  if (y === 0) return current;
  if (!Number.isInteger(y) || y < 2000 || y > current) {
    throw Error('year must be between 2000 and ' + current + ' (0 = current year)');
  }
  return y;
}


function sanitizeFolderName(name, label) {
  if (typeof name === 'number') name = String(name);
  if (typeof name !== 'string' || name.trim() === '' || name.length > 255) {
    throw Error(label + ' must be a folder name');
  }
  return name;
}


// USER and ACCOUNTANT resolve to the configured addresses, anything else must be an email.
function sanitizeMailTo(option) {
  const list = getConfig_().MAIL_LIST;
  if (option === MAIL_TO.USER) return list.USER;
  if (option === MAIL_TO.ACCOUNTANT) return list.ACCOUNTANT;
  if (typeof option === 'string' && EMAIL_PATTERN.test(option)) return option;
  throw Error('mail_to must be USER, ACCOUNTANT or a valid email address');
}


function sanitizeIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_DOWNLOAD_IDS) {
    throw Error('ids must be a list of 1 to ' + MAX_DOWNLOAD_IDS + ' file IDs');
  }
  ids.forEach(id => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{5,200}$/.test(id)) throw Error('ids contains an invalid file ID');
  });
  return ids;
}


// ---------------------------------------------------------------------------
// Drive helpers
// ---------------------------------------------------------------------------

// Drive keeps trashed items as children of their folder, so every listing
// goes through these helpers, which leave the trash out.
const NOT_TRASHED = 'trashed = false';

function nameQuery_(name) {
  return "title = '" + String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "' and " + NOT_TRASHED;
}

function liveFiles_(folder) {
  return folder.searchFiles(NOT_TRASHED);
}

function liveFolders_(folder) {
  return folder.searchFolders(NOT_TRASHED);
}

function filesByName_(folder, name) {
  return folder.searchFiles(nameQuery_(name));
}

function foldersByName_(folder, name) {
  return folder.searchFolders(nameQuery_(name));
}


let ROOT_FOLDER_CACHE_ = null;

// The folder that holds every archive. Tries the configured ID, then the ID
// remembered from an earlier run, then a folder with the configured name, and
// only creates a new folder when none of those exist.
function getRootDirectory() {

  if (ROOT_FOLDER_CACHE_) return ROOT_FOLDER_CACHE_;

  const config = getConfig_();
  const props = PropertiesService.getScriptProperties();
  const candidates = [config.ROOT_FOLDER_ID, props.getProperty('ROOT_FOLDER_ID')];

  for (const id of candidates) {
    if (!id) continue;
    try {
      ROOT_FOLDER_CACHE_ = DriveApp.getFolderById(id);
      return ROOT_FOLDER_CACHE_;
    } catch (e) {
      // not accessible, try the next candidate
    }
  }

  const name = config.ROOT_FOLDER_NAME || 'dataccent-invoice-mail';
  const byName = DriveApp.searchFolders(nameQuery_(name));
  const folder = byName.hasNext() ? byName.next() : DriveApp.createFolder(name);

  props.setProperty('ROOT_FOLDER_ID', folder.getId());

  ROOT_FOLDER_CACHE_ = folder;
  return folder;
}


// Returns the named subfolder, creating it when missing. `cache` avoids asking
// Drive for the same folder again during one run.
function getOrCreateFolder_(parent, name, cache) {

  const key = parent.getId() + '/' + name;

  if (cache[key]) return cache[key];

  const it = foldersByName_(parent, name);

  cache[key] = it.hasNext() ? it.next() : parent.createFolder(name);

  return cache[key];
}


// Looks up <root>/<parentName>/<childName>. Never creates anything.
function findArchiveFolder_(parentName, childName) {

  const parents = foldersByName_(getRootDirectory(), parentName);

  if (!parents.hasNext()) throw Error('Folder "' + parentName + '" was not found');

  const children = foldersByName_(parents.next(), childName);

  if (!children.hasNext()) throw Error('Folder "' + parentName + ' / ' + childName + '" was not found');

  return children.next();
}


function isZipName_(name) {
  return String(name).toLowerCase().endsWith('.zip');
}


function isArchiveParentName_(name) {
  return /^20\d{2}$/.test(name) || name === LEGACY_NEWER_THAN_FOLDER;
}


// "invoice.pdf", 2 -> "invoice (2).pdf"
function withSuffix_(name, n) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name + ' (' + n + ')';
  return name.slice(0, dot) + ' (' + n + ')' + name.slice(dot);
}


// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

// Prepends an entry to logger.log in the root folder, keeping the file small.
function logger(data) {

  try {

    const root = getRootDirectory();
    const files = filesByName_(root, 'logger.log');
    const logFile = files.hasNext() ? files.next() : root.createFile('logger.log', '');

    const entry = '[DATE]\n' + new Date() + '\n[DATA]\n' + JSON.stringify(data) + '\n\n';

    const content = entry + logFile.getBlob().getDataAsString();

    logFile.setContent(content.slice(0, LOG_MAX_CHARS));

  } catch (e) {

    console.log('logger failed: ' + e);
  }
}


// ---------------------------------------------------------------------------
// Fetch: Gmail -> Drive
// ---------------------------------------------------------------------------

// Finds invoices in the requested period and saves the new ones to Drive.
// Returns { saved: [file], existing: [file] } where file is
//   { id, parent_folder, child_folder, sender, name, size }.
function fetchInvoices(params) {

  const range = getFetchRange_(params);

  const invoices = getInvoices_(range);

  return saveInvoices_(invoices);
}


// Same as fetchInvoices, then mails every month folder that got a match to the user.
function fetchInspectInvoices(params) {

  const result = fetchInvoices(params);

  const user = getConfig_().MAIL_LIST.USER;
  const seen = {};

  result.mailed = [];

  result.saved.concat(result.existing).forEach(file => {

    const key = file.parent_folder + '/' + file.child_folder;

    if (seen[key]) return;
    seen[key] = true;

    const folder = findArchiveFolder_(file.parent_folder, file.child_folder);
    const sent = mailFolder_(folder, user);

    sent.parent_folder = file.parent_folder;
    sent.child_folder = file.child_folder;

    result.mailed.push(sent);
  });

  return result;
}


// The period to fetch as { start, end } dates, start inclusive and end exclusive.
function getFetchRange_(params) {

  if (params.fetch_type === FETCH_TYPE.MONTH_YEAR) {
    return {
      start: new Date(params.year, params.month - 1, 1),
      end: new Date(params.year, params.month, 1)
    };
  }

  const now = Date.now();

  return {
    start: new Date(now - params.newer_than * DAY_MS),
    end: new Date(now + 60 * 1000)
  };
}


function getInvoices_(range) {

  const threads = searchThreads_(buildGmailQuery_(range));

  const searchTerms = SEARCH_TERMS.map(normalize_);

  const groups = collectAttachments_(threads, range, searchTerms);

  return filterDuplicateAttachments_(groups);
}


// Gmail reads yyyy/mm/dd dates in its own timezone, so the query uses epoch
// seconds and is a day wider on both sides. collectAttachments_ then keeps only
// the messages that really fall inside the range.
function buildGmailQuery_(range) {

  const after = Math.floor((range.start.getTime() - DAY_MS) / 1000);
  const before = Math.ceil((range.end.getTime() + DAY_MS) / 1000);

  return 'in:anywhere has:attachment filename:pdf after:' + after + ' before:' + before;
}


function searchThreads_(query) {

  const threads = [];

  for (let start = 0; ; start += GMAIL_PAGE_SIZE) {

    const page = GmailApp.search(query, start, GMAIL_PAGE_SIZE);

    page.forEach(thread => threads.push(thread));

    if (page.length < GMAIL_PAGE_SIZE) break;
  }

  return threads;
}


// Groups the PDF attachments that look like invoices (by subject or file name)
// under a loose key of name + size. Messages outside the range are skipped.
function collectAttachments_(threads, range, searchTerms) {

  const groups = new Map();

  if (threads.length === 0) return groups;

  const messagesByThread = GmailApp.getMessagesForThreads(threads);

  threads.forEach((thread, index) => {

    const normThreadSubject = normalize_(thread.getFirstMessageSubject() || "");

    for (const msg of messagesByThread[index]) {

      const date = msg.getDate();

      if (date < range.start || date >= range.end) continue;

      const normMsgSubject = normalize_(msg.getSubject() || "");

      const subjectMatches = searchTerms.some(t =>
        normThreadSubject.includes(t) || normMsgSubject.includes(t)
      );

      const atts = msg.getAttachments({ includeInlineImages: false });

      for (const att of atts) {

        const name = att.getName() || "";

        const isPdf =
          att.getContentType() === "application/pdf" ||
          name.toLowerCase().endsWith(".pdf");

        if (!isPdf) continue;

        const nameMatches = searchTerms.some(t => normalize_(name).includes(t));

        if (!(subjectMatches || nameMatches)) continue;

        const keyLoose = `${name}__${att.getSize()}`;

        if (!groups.has(keyLoose)) groups.set(keyLoose, []);

        groups.get(keyLoose).push({ msg, att });
      }
    }
  });

  return groups;
}


// Attachments that share a name and size are compared by content hash, and
// only the first copy of each is kept.
function filterDuplicateAttachments_(groups) {

  const seenStrict = new Set();

  const invoices = [];

  const add = (msg, att) => invoices.push({
    from: extractEmail(msg.getFrom()),
    invoice: att,
    date: msg.getDate()
  });

  for (const items of groups.values()) {

    if (items.length === 1) {
      add(items[0].msg, items[0].att);
      continue;
    }

    for (const { msg, att } of items) {

      const bytes = att.getBytes();

      const hash = Utilities.base64Encode(
        Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
      );

      const keyStrict = `${att.getName()}__${bytes.length}__${hash}`;

      if (seenStrict.has(keyStrict)) continue;

      seenStrict.add(keyStrict);

      add(msg, att);
    }
  }

  invoices.sort((a, b) => a.date.getTime() - b.date.getTime());

  return invoices;
}


// Files every invoice under <year>/Τιμολόγια_<month>_<year>/<sender>/ by the
// date of its email.
function saveInvoices_(invoices) {

  const root = getRootDirectory();
  const folderCache = {};
  const fileCache = {};
  const result = { saved: [], existing: [] };

  invoices.forEach(inv => {

    const year = String(inv.date.getFullYear());
    const monthName = MONTHS[inv.date.getMonth()];
    const monthFolderName = folderNameFromMonth(inv.date.getMonth() + 1, year);
    const senderName = safeSenderName_(inv.from);

    const yearFolder = getOrCreateFolder_(root, year, folderCache);
    const monthFolder = getOrCreateFolder_(yearFolder, monthFolderName, folderCache);
    const senderFolder = getOrCreateFolder_(monthFolder, senderName, folderCache);

    const stored = saveToFolder_(inv.invoice, senderFolder, monthName, fileCache);

    const record = {
      id: stored.id,
      parent_folder: year,
      child_folder: monthFolderName,
      sender: senderName,
      name: stored.name,
      size: stored.size
    };

    (stored.created ? result.saved : result.existing).push(record);
  });

  return result;
}


// Saves one attachment as "<month>_<attachment name>". A file with that name
// and the same size is taken to be the same invoice and is left alone. A file
// with that name and a different size is a different invoice, so the new one
// is saved as "<name> (2).pdf", "(3)" and so on.
function saveToFolder_(attachment, folder, monthName, fileCache) {

  const existing = filesInFolder_(folder, fileCache);

  const baseName = monthName + '_' + (attachment.getName() || 'invoice.pdf');

  let byteLength = null;

  const sameSize = (size) => {
    if (size === attachment.getSize()) return true;
    if (byteLength === null) byteLength = attachment.getBytes().length;
    return size === byteLength;
  };

  let name = baseName;

  for (let n = 2; existing[name]; n++) {

    if (sameSize(existing[name].size)) {
      return { id: existing[name].id, name: name, size: existing[name].size, created: false };
    }

    name = withSuffix_(baseName, n);
  }

  const blob = attachment.copyBlob().setName(name).setContentType(MimeType.PDF);

  const file = folder.createFile(blob);

  existing[name] = { id: file.getId(), size: file.getSize() };

  return { id: existing[name].id, name: name, size: existing[name].size, created: true };
}


// { fileName: { id, size } } for a folder, read from Drive once per run.
function filesInFolder_(folder, fileCache) {

  const key = folder.getId();

  if (fileCache[key]) return fileCache[key];

  const byName = {};

  const files = liveFiles_(folder);

  while (files.hasNext()) {
    const file = files.next();
    byName[file.getName()] = { id: file.getId(), size: file.getSize() };
  }

  fileCache[key] = byName;

  return byName;
}


function folderNameFromMonth(month, year) {

  const m = Number(month);

  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error("Month must be 1-12 (Jan=1, Dec=12).");
  }

  return `Τιμολόγια_${MONTHS[m - 1]}_${year}`;
}


function safeSenderName_(sender) {
  return (sender || "unknown_sender")
    .toString()
    .replace(/[\/\\:*?"<>|]/g, "_");
}


function extractEmail(fromHeader) {

  const m = String(fromHeader || '').match(/<([^>]+)>/);

  return m ? m[1] : String(fromHeader || '');
}


function normalize_(s) {

  return (s || "")
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}


// ---------------------------------------------------------------------------
// Listing and download
// ---------------------------------------------------------------------------

// { "<year>": ["<month folder>", ...], ... } for every archive parent in the root.
function logdirs(params) {

  const tree = {};

  const parents = liveFolders_(getRootDirectory());

  while (parents.hasNext()) {

    const parent = parents.next();
    const parentName = parent.getName();

    if (!isArchiveParentName_(parentName)) continue;

    if (!tree[parentName]) tree[parentName] = [];

    const children = liveFolders_(parent);

    while (children.hasNext()) {
      tree[parentName].push(children.next().getName());
    }
  }

  return tree;
}


// The files of one month folder: { parent_folder, child_folder, files, zips }.
// `sender` is the subfolder a file sits in ('' for the month folder itself).
function listFiles(params) {

  const folder = findArchiveFolder_(params.parent_folder, params.child_folder);

  const out = {
    parent_folder: params.parent_folder,
    child_folder: params.child_folder,
    files: [],
    zips: []
  };

  listFolderFiles_(folder, '', out);

  return out;
}


function listFolderFiles_(folder, sender, out) {

  const files = liveFiles_(folder);

  while (files.hasNext()) {

    const file = files.next();

    const record = {
      id: file.getId(),
      parent_folder: out.parent_folder,
      child_folder: out.child_folder,
      sender: sender,
      name: file.getName(),
      size: file.getSize()
    };

    (isZipName_(record.name) ? out.zips : out.files).push(record);
  }

  const subfolders = liveFolders_(folder);

  while (subfolders.hasNext()) {
    const sub = subfolders.next();
    listFolderFiles_(sub, sender ? sender + '/' + sub.getName() : sub.getName(), out);
  }
}


// Returns file contents as base64 for the given Drive IDs. Only files inside
// the invoice root are served. The response is capped in size: IDs that did
// not fit come back in `remaining` and should be asked for again.
function getFiles(params) {

  const rootId = getRootDirectory().getId();
  const insideCache = {};
  const out = { files: [], remaining: [], errors: [] };

  let total = 0;

  params.ids.forEach(id => {

    try {

      const file = DriveApp.getFileById(id);

      if (!isInsideRoot_(file, rootId, insideCache, 0)) throw Error('File is not part of the invoice archive');

      const size = file.getSize();

      if (size > MAX_DOWNLOAD_FILE_BYTES) throw Error('File is too large to download through the API');

      if (out.files.length > 0 && total + size > MAX_DOWNLOAD_BYTES) {
        out.remaining.push(id);
        return;
      }

      total += size;

      out.files.push({
        id: id,
        name: file.getName(),
        size: size,
        data: Utilities.base64Encode(file.getBlob().getBytes())
      });

    } catch (e) {

      out.errors.push({ id: id, error: (e && e.message) ? String(e.message) : String(e) });
    }
  });

  return out;
}


function isInsideRoot_(item, rootId, cache, depth) {

  const parents = item.getParents();

  while (parents.hasNext()) {

    const parent = parents.next();
    const id = parent.getId();

    if (id === rootId) return true;

    if (cache[id] === undefined) {
      cache[id] = depth < 6 ? isInsideRoot_(parent, rootId, cache, depth + 1) : false;
    }

    if (cache[id]) return true;
  }

  return false;
}


// ---------------------------------------------------------------------------
// Mailer
// ---------------------------------------------------------------------------

function mailExecute(params) {

  const folder = findArchiveFolder_(params.parent_folder, params.child_folder);

  return mailFolder_(folder, params.mail_to);
}


// Zips a month folder and mails it. Zips over the Gmail attachment limit are
// saved in the folder and shared as a Drive link instead.
function mailFolder_(folder, mailTo) {

  const folderName = folder.getName();

  const blobs = collectBlobs_(folder, folderName.replace(/[\/\\]/g, '-'), [], {});

  if (blobs.length === 0) throw Error('Folder "' + folderName + '" has no files to send');

  const zipName = folderName.replace(/[\/\\]/g, '-') + '.zip';

  const zip = Utilities.zip(blobs, zipName);

  const bytes = zip.getBytes().length;

  if (bytes === 0) throw Error('Could not zip the files of "' + folderName + '"');

  if (bytes <= MAX_MAIL_ATTACHMENT_BYTES) {

    GmailApp.sendEmail(mailTo, folderName, '', { attachments: [zip] });

    return { mail_to: mailTo, mode: 'attachment', files: blobs.length, bytes: bytes };
  }

  const old = filesByName_(folder, zipName);

  while (old.hasNext()) old.next().setTrashed(true);

  const saved = folder.createFile(zip);

  saved.addViewer(mailTo);

  GmailApp.sendEmail(mailTo, folderName, saved.getUrl());

  return { mail_to: mailTo, mode: 'drive_link', files: blobs.length, bytes: bytes, url: saved.getUrl() };
}


// Every file under `folder` as a blob named with its path inside the zip.
// Zip files are skipped so an old zip never ends up inside a new one.
function collectBlobs_(folder, prefix, blobs, usedNames) {

  const files = liveFiles_(folder);

  while (files.hasNext()) {

    const file = files.next();

    if (isZipName_(file.getName())) continue;

    const base = prefix + '/' + file.getName();

    let path = base;

    for (let n = 2; usedNames[path]; n++) path = withSuffix_(base, n);

    usedNames[path] = true;

    blobs.push(file.getBlob().setName(path));
  }

  const subfolders = liveFolders_(folder);

  while (subfolders.hasNext()) {
    const sub = subfolders.next();
    collectBlobs_(sub, prefix + '/' + sub.getName(), blobs, usedNames);
  }

  return blobs;
}


// ---------------------------------------------------------------------------
// Removal (items go to the Drive trash, where they can be restored for 30 days)
// ---------------------------------------------------------------------------

// Trashes the zip files that sit directly in a month folder.
function removeZipFiles(params) {

  const folder = findArchiveFolder_(params.parent_folder, params.child_folder);

  const files = liveFiles_(folder);

  let removed = 0;

  while (files.hasNext()) {

    const file = files.next();

    if (isZipName_(file.getName())) {
      file.setTrashed(true);
      removed++;
    }
  }

  return { removed: removed };
}


// Trashes a month folder with everything in it.
function removeArchives(params) {

  const folder = findArchiveFolder_(params.parent_folder, params.child_folder);

  folder.setTrashed(true);

  return { removed: true };
}
