const APP_ROOT_FOLDER = getRootDirectory();

const MODE = 'PROD' // DEBUG | PROD

// Emails and the Drive folder ID live in Config.gs (not committed, see Config.example.gs)
const MAIL_LIST = Object.freeze(getConfig_().MAIL_LIST);


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
  MAILER: "MAILER"
});


const FETCH_TYPE = Object.freeze({
  NEWER_THAN: "NEWER_THAN",
  MONTH_YEAR: "MONTH_YEAR",
});


function getRootDirectory() {

  try {

    const root = DriveApp.getFolderById(getConfig_().ROOT_FOLDER_ID);

    return root;

  } catch (e) {

    const root = DriveApp.createFolder('dataccent-invoice-mail');

    return root;
  }
}


//PARAM JSON SCHEMA
  const TESTING_DATA = {
    month: "0",
    year: "0",
    newer_than: "10",
    fetch_type: FETCH_TYPE.MONTH_YEAR,
    action: ACTIONS.FETCH,
    parent_folder: "",
    child_folder: ""
}

function exec(exec_type = 'T_FETCH', params) {

  const exec_data = MODE === "DEBUG"? TESTING_DATA : params; 

  const result = sanitizeParamObject(exec_data);

  if (!result.ok) {
       logger(result.err);
      return result;
  }

  switch (exec_type) {

    case ACTIONS.FETCH:
      return safe_run_(exec_type, result.params, fetchInvoices);

    case ACTIONS.FETCH_N_INSPECT:
      return safe_run_(exec_type, result.params, fetchInspectInvoices);

    case ACTIONS.REMOVE_ZIP_FILES:
      return safe_run_(exec_type, result.params, removeZipFiles);

    case ACTIONS.REMOVE_ARCHIVES:
      return safe_run_(exec_type, result.params, removeArchives);

    case ACTIONS.FETCH_DIR_STRUCTURE:
      return safe_run_(exec_type, result.params, logdirs);

    case ACTIONS.MAILER_EXECUTE:
      return safe_run_(exec_type, result.params, mailExecute);
  }
}


function isPlainObject(x) {
  if (x === null || typeof x !== "object") return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}


function validateAction(action) {
  if (!Object.values(ACTIONS).includes(action) && action !== '') throw Error('validateAction: Action doesnt exist');
  return action;

}


function validateFetchType(fetchType) {
  if (!Object.values(FETCH_TYPE).includes(fetchType) && fetchType !== '') throw Error('validateFetchType: Fetch type doesnt exist');
  return fetchType;

}


function sanitizeNewerThan(newerThan) {
  const newer_than = Number(newerThan);
  if (newerThan !== '' && newer_than < 0 || newer_than > 90) throw Error('sanitizeNewerThan: Newer than value is invalid');
  return newerThan;

}


function sanitizeYear(year) {

   if (year === FETCH_TYPE.NEWER_THAN) return year;

  const y = Number(year)

  if (/\d{4}/.test(y) && y <= new Date().getFullYear()) {

    return y;

  } else if (y === 0) {

    return new Date().getFullYear()

  } else

    throw Error('sanitizeYear: Year Argument is invalid');

}


function sanitizeMonth(month) {

  if (month < 0 || month > 12) {

    throw Error('The month value provided is invalid')

  } else if (!month) {

    const current = new Date().getMonth();

    return current + 1

  } else {

    return month
  }
}


function sanitizeMailerParams(option){

    if (option === MAIL_TO.USER) {

    return  MAIL_LIST[MAIL_TO.USER];

  } else if (option === MAIL_TO.ACCOUNTANT) {

    return MAIL_LIST[MAIL_TO.ACCOUNTANT];

  } else if (
    ! /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/
  .test(option)) throw Error('mailer: Mail formatting is invalid');

}



function logger(data){

const logFile = createOrReturnFile(APP_ROOT_FOLDER, 'logger.log');

const existingContent = logFile.getBlob().getDataAsString();

const mode = `[MODE]\n${MODE}`; 

const date  = '[DATE]\n'+ new Date();

const newData = `[DATA]\n${JSON.stringify(data)}`

const formatedData =   date + '\n' + mode + '\n' + newData + '\n\n';

if (MODE === 'DEBUG') 
   console.log(formatedData);

logFile.setContent(formatedData + existingContent);

}


function createOrReturnFile(folder, fileName){

  const file = folder.getFilesByName(fileName);

  if (file.hasNext()) return file.next();
   return folder.createFile(fileName, ''); 
}


function sanitizeParamObject(params) {

  try{

  if (!isPlainObject(params)) throw Error('sanitizeParamObject: Param type is not an object');

  for ([key, value] of Object.entries(params)) {

    switch (key) {

      case "month":
      case "child_folder":
        params[key] = sanitizeMonth(value); break;

      case "year":
      case "parent_folder":
        params[key] = sanitizeYear(value); break;

      case "action":
        params[key] = validateAction(value); break;
        
      case 'fetch_type':
        params[key] = validateFetchType(value); break;
       
      case 'newer_than':
        params[key] = sanitizeNewerThan(value); break;

      case 'mail_to':
        params[key] = sanitizeMailerParams(value); break;
       
    }
  }

  return {
      ok: true, 
      params : params
    };

  } catch(e){

    return {
      ok: false, 
      err : e.message,
      params: params
    };

  }

}


function mailExecute(params) {

  return mailer(params);

}


function mailer(params) {

  const p = params.parent_folder === FETCH_TYPE.NEWER_THAN ? params.parent_folder : params.parent_folder;

  const parent_folder = createArchive(p, APP_ROOT_FOLDER);

  const child_folder = createArchive(params.child_folder, parent_folder);

  let blobs = [];

  blobInvoices(child_folder, child_folder.getName(), blobs, params.child_folder);

  let zip = zipBlobs(blobs, params.child_folder)

  mailBlobInvoices(params.mail_to, params.child_folder, zip);

  return true;

}


function returnDirectoriesJson(root_folder, folderTree) {

  while (root_folder.hasNext()) {

    const folder = root_folder.next();

    const folder_name = folder.getName();

    if (/20[2-6][0-9]/.test(folder_name) || folder_name === FETCH_TYPE.NEWER_THAN) {

      if (!folderTree[folder_name]) folderTree[folder_name] = [];

      const folder_c = folder.getFolders();

      while (folder_c.hasNext()) {

        const folder2 = folder_c.next();

        folderTree[folder_name].push(folder2.getName())

      }
    }
  }
}


function logdirs(exec_params) {

  let obj = {};

  const folders = getRootDirectory().getFolders();

  returnDirectoriesJson(folders, obj);

  return obj;
}


function safe_run_(exec_type, params = '', fn) {

  try {

    const returnVal = fn(params);

    return {

      ok: true,

      return_value: returnVal,

      exec_type: exec_type,

      params: params
    };

  } catch (e) {

    const return_ob = {

      ok: false,

      return_value: e.toString(),

      exec_type: exec_type,

      params: params

    };

    logger(return_ob)

    return return_ob;
  }
}


function blobInvoices(folder, root_folder_name, blobs, blob_name = '') {

  const folder_name = blob_name + '/' + folder.getName();

  const files = folder.getFiles();

  while (files.hasNext()) {

    const file = files.next();

    const file_name = folder_name + '/' + file.getName()

    const blob = file.getBlob().setName(file_name);

    blobs.push(blob)
  }

  const folders = folder.getFolders();

  while (folders.hasNext()) {

    const folder = folders.next();

    blobInvoices(folder, root_folder_name, blobs)
  }

  return blobs;
}


//takes a int 1-12 return the greek name for the archive 
function createArchiveName(month, year) {

  return folderNameFromMonth(month, year)
}


//GETS INVOICES FROM MAIL INBOX
//SAVES PDF FILES ON G DRIVE
//SENDS THEM TO THE USER VIA EMAIL FOR INSPECTION
function fetchInspectInvoices(exec_params) {

  const archive_name = getExecTypeArchiveName(exec_params);

  const archive_parent =
    exec_params.fetch_type === FETCH_TYPE.MONTH_YEAR ?
      createArchive(exec_params.year, APP_ROOT_FOLDER) : createArchive(FETCH_TYPE.NEWER_THAN, APP_ROOT_FOLDER);


  const dateArchive = createArchive(archive_name, archive_parent);

  const invoices = getInvoices(exec_params);

  saveInvoices(invoices, exec_params);

  let blobs = [];


  blobInvoices(dateArchive, archive_parent, blobs, archive_name);

  if (blobs.length === 0)
    throw Error(`blobInvoices: Folder "${dateArchive}" is empty, no files to send.`);

  const zip = zipBlobs(blobs, archive_name);

  mailSavedInvoices(MAIL_LIST[MAIL_TO.USER], archive_name, saveZip(dateArchive, zip));


  return true;
}


function zipBlobs(blobs, folder_name) {

  if (blobs.length === 0)
    throw Error(`zipBlob: Error blob array is empty`);

  const zip = Utilities.zip(blobs, folder_name.endsWith('.zip') ? folder_name : folder_name + '.zip')

  if (zip.getBytes().length === 0)
    throw Error(`zipBlob: Error couldnt zip files for ${folder_name}`);


  return zip;

}


function getParamsFromMode(params) {

  return params.fetch_type === FETCH_TYPE.NEWER_THAN ? params.newer_than : [params.month, params.year];

}


function fetchInvoices(params) {

  const invoices = getInvoices(params);

  if (saveInvoices(invoices, params)) {
    return true;
  }

  throw Error('fetchInvoices: Saving to drive failed');
}


function getExecTypeArchiveName(exec_params) {

  if (exec_params.fetch_type === FETCH_TYPE.MONTH_YEAR) {
console.log("month year runs")
    return folderNameFromMonth(exec_params.month, exec_params.year);

  } else {

    return getNameForNewerThanArchive(exec_params.newer_than);

  }

}


function saveInvoices(invoices, exec_params) {

  let archiveName = getExecTypeArchiveName(exec_params);

  const exec_type = exec_params.fetch_type;

  switch (exec_type) {

    case FETCH_TYPE.NEWER_THAN:

      invoices.forEach(child => {

        const parentArchive = createArchive(archiveName, createArchive(FETCH_TYPE.NEWER_THAN, APP_ROOT_FOLDER));

        const sender_folder = createSenderFolder(parentArchive, child.from);

        saveToFolder(child.invoice, sender_folder, child.month);
      });

      break;

    case FETCH_TYPE.MONTH_YEAR:

      invoices.forEach(child => {

        const parentArchive = createArchive(child.year, APP_ROOT_FOLDER);

        const dateArchive = createArchive(archiveName, parentArchive);

        const sender_folder = createSenderFolder(dateArchive, child.from);

        saveToFolder(child.invoice, sender_folder, child.month);
      });

      break;

  }

  return true;
}


function getNameForNewerThanArchive(daysBack, baseDate = new Date()) {

  console.log("getNameForNewerThanArchive", daysBack);

  const n = Number(daysBack);

  if (!Number.isFinite(n) || n < 0) {

    throw new Error("daysBack must be a non-negative number");

  }

  const end = new Date(baseDate);

  const start = new Date(end);

  start.setDate(start.getDate() - n);

  const format = (d) => {

    const day = d.getDate();

    const month = String(d.getMonth() + 1).padStart(2, "0");

    const year = d.getFullYear();

    return `${day}/${month}/${year}`;

  };

  return `Τιμολόγια_${format(start)}-${format(end)}`;
}


function createSenderFolder(p_folder, sender_name) {

  const safeName = (sender_name || "unknown_sender")
    .toString()
    .replace(/[\/\\:*?"<>|]/g, "_");

  const it = p_folder.getFoldersByName(safeName);

  if (it.hasNext()) {

    return it.next();
  }

  return p_folder.createFolder(safeName);
}


//Creates or if exist returns the directory
function createArchive(archive_name, saveFolder) {

  const it = saveFolder.getFoldersByName(archive_name);

  if (it.hasNext()) {

    return it.next();

  }

  return saveFolder.createFolder(archive_name);
}


function saveToFolder(invoice, folder, date) {

  const name = `${date}_${invoice.getName()}`;

  if (fileExists(folder, name)) {
    return true;
  }

  const pdfBlob = invoice.copyBlob()
    .setName(name)
    .setContentType(MimeType.PDF);

  return folder.createFile(pdfBlob);
}


//Removes all zip files in a specified directory
function removeZipFiles(params) {

  const Archive_f = createArchive(params.child_folder, createArchive(params.parent_folder, APP_ROOT_FOLDER));

  const files = Archive_f.getFiles();

  while (files.hasNext()) {

    const file = files.next();

    const file_name = file.getName();

    if (file_name.toLowerCase().endsWith('.zip')) {

      Drive.Files.remove(file.getId());
    }
  }
}



function removeFolder(folderId) {

  const folder = DriveApp.getFolderById(folderId);

  const files = folder.getFiles();

  while (files.hasNext()) {

    const file = files.next();

    Drive.Files.remove(file.getId());

  }

  const subfolders = folder.getFolders();

  while (subfolders.hasNext()) {

    const subfolder = subfolders.next();

    removeFolder(subfolder.getId());

  }

  Drive.Files.remove(folderId);
}


function removeArchives(params) {

  const yearArchive = createArchive(params.parent_folder, APP_ROOT_FOLDER);

  const folders = yearArchive.getFoldersByName(params.child_folder);

  while (folders.hasNext()) {

    removeFolder(folders.next().getId());

    return true;
  }
}


function mailSavedInvoices(mail_to, subject, saved_zip) {

  const MAX = 20 * 1024 * 1024;

  if (saved_zip.getBlob().getBytes().length <= MAX) {

    GmailApp.sendEmail(mail_to, subject, '', { attachments: [saved_zip.getBlob()] });

    const zip_file_id = saved_zip.getId();

    Drive.Files.remove(String(zip_file_id))

    return;

  } else {

    saved_zip.addViewer(mail_to);

    GmailApp.sendEmail(mail_to, subject, '' + '\n\n' + saved_zip.getUrl());
  }
}


function mailBlobInvoices(mail_to, subject, zip_blob) {

  const MAX = 20 * 1024 * 1024;

  if (zip_blob.getBytes().length <= MAX) {

    GmailApp.sendEmail(mail_to, subject, '', { attachments: [zip_blob] });

    return;

  } else {

    const saved_zip = saveZip(APP_ROOT_FOLDER, zip_blob)?.addViewer(mail_to);

    GmailApp.sendEmail(mail_to, subject, '' + '\n\n' + saved_zip.getUrl());
  }
}


function saveZip(folder, zip) {

  return folder.createFile(zip);
}


function extractEmail(fromHeader) {

  const m = fromHeader.match(/<([^>]+)>/);

  return m ? m[1] : fromHeader;
}


function fileExists(folder, name) {

  let file = folder.getFilesByName(name);

  while (file.hasNext()) {

    return true;

  }
}


//Fetch invoice threads from Gmail.
function getInvoicesFromMail(params) {

  const base = "in:anywhere has:attachment filename:pdf";

  if (params.fetch_type === FETCH_TYPE.MONTH_YEAR) {
   
    let year = Number(params.year);

    let month = Number(params.month);

    month = month == 0 ? new Date().getMonth() + 1 : month;

    year = year == 0 ? new Date().getFullYear() : year;

    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {

      throw new Error('Month filter must be [month, year] with month 1-12, e.g. [1,2026].');

    }

    const start = new Date(year, month - 1, 1);

    const end = new Date(year, month, 1);

    const tz = Session.getScriptTimeZone();

    const fmt = d => Utilities.formatDate(d, tz, "yyyy/MM/dd");

    const query = `${base} after:${fmt(start)} before:${fmt(end)}`;

    return GmailApp.search(query);
  }

  const days = params.newer_than;

  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;


  const query = `${base} newer_than:${safeDays}d`;

  return GmailApp.search(query);
}


//gets a Date object as returned by the message.getMessages() method 
function monthNameElFromDate(date) {

  return MONTHS[date.getMonth()];
}


function folderNameFromMonth(month, year) {
  console.log(month,year)

  let m = Number(month);

  if (MONTHS.includes(month)){
    return `Τιμολόγια_${month}_${year}`;
  }

  if (!Number.isInteger(m) || m > 12) {

    throw new Error("Month must be 1-12 (Jan=1, Dec=12).");

  } else if (!Number.isInteger(m) || m === 0) {

    m = new Date().getMonth() + 1;

  }

  const monthName = MONTHS[m - 1];

return `Τιμολόγια_${monthName}_${year}`;
  
}


function filterMailsByTerms(threads, searchTerms) {

  const groups = new Map();

  for (const thread of threads) {

    const threadSubject = thread.getFirstMessageSubject() || "";

    const normThreadSubject = normalize_(threadSubject);

    for (const msg of thread.getMessages()) {

      const msgSubject = msg.getSubject() || "";

      const normMsgSubject = normalize_(msgSubject);

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

        const normAttName = normalize_(name);

        const nameMatches = searchTerms.some(t => normAttName.includes(t));

        if (!(subjectMatches || nameMatches)) continue;

        const keyLoose = `${name}__${att.getSize()}`;

        if (!groups.has(keyLoose)) groups.set(keyLoose, []);

        groups.get(keyLoose).push({ msg, att });

      }
    }
  }

  return groups;
}


function filterDuplicateAttachments(mailMap) {

  const seenStrict = new Set();

  const pdf = [];

  for (const items of mailMap.values()) {

    if (items.length === 1) {

      const { msg, att } = items[0];

      const msg_date = msg.getDate();

      pdf.push({
        from: extractEmail(msg.getFrom()),
        invoice: att,
        month: monthNameElFromDate(msg_date),
        year: msg_date.getFullYear(),
        full_date: msg_date
      });

      continue;

    }
    //strong check
    for (const { msg, att } of items) {

      const bytes = att.getBytes();

      const msg_date = msg.getDate();


      const hash = Utilities.base64Encode(
        Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
      );

      const keyStrict = `${att.getName()}__${bytes.length}__${hash}`;

      if (seenStrict.has(keyStrict)) continue;

      seenStrict.add(keyStrict);


      pdf.push({
        from: extractEmail(msg.getFrom()),
        invoice: att,
        month: monthNameElFromDate(msg_date),
        year: msg_date.getFullYear(),
        full_date: msg_date
      });
    }
  }

  return pdf;
}


function getInvoices(exec_params) {

  const threads = getInvoicesFromMail(exec_params);

  const searchTerms = ['τιμολογ', 'invoice', 'παραστατ'].map(normalize_);

  const filteredMails = filterMailsByTerms(threads, searchTerms);

  const from_and_attachments = filterDuplicateAttachments(filteredMails);

  return from_and_attachments;

}


function logFilteredMail(){
 for (const [key, value] of filteredMails) {
  Logger.log(` key: ${key}`);

  for (const { msg, att } of value) {
    Logger.log(`  value: ${msg.getSubject()} | File: ${att.getName()} | Size: ${att.getSize()}`);
  }
}

}

function normalize_(s) {

  return (s || "")
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}


