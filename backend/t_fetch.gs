
const T_TESTING_DATA = {
  month: "0",
  year: "0",
  newer_than: "10",
  fetch_type: FETCH_TYPE.MONTH_YEAR,
  action: ACTIONS.FETCH,
  month_year: [{ month: "0", year: 2026 }, { month: "1", year: 2026 }],
  parent_child_folders : [{ 2026:  ["Τιμολόγια_Μάρτιος_2026" , "Τιμολόγια_Φεβρουάριος_2026"] }]
}

function t_fetchInvoices(params = T_TESTING_DATA) {

  const invoices = t_getInvoices(params);

  if (t_saveInvoices(invoices, params)?.ok) {
    return true;
  }

  throw Error('fetchInvoices: Saving to drive failed');
}


function t_mailer(params) {

  const MODE = params.fetch_type;

  switch (MODE){

    case FETCH_TYPE.MONTH_YEAR:

    const folders = fetchFolders(params.parent_child_folders);

    const blobMap = blobAllFolders(folders);

    const zipedBlobs = zipAllBlobs(blobMap);

    const saved = saveAllZips(zipedBlobs);

    Logger.log(saved)

    t_mailSavedInvoices(MAIL_LIST[MAIL_TO.USER], 'Τιμολόγια', saved);

    break;

    case FETCH_TYPE.NEWER_THAN:

    break;

  }

  return true;
}



function t_fetchInspectInvoices(exec_params = T_TESTING_DATA) {

  const invoices = t_getInvoices(exec_params);

  const savedinvoices = t_saveInvoices(invoices, exec_params);

  if (savedinvoices?.ok) {

    console.log("fetched folders structure: " , savedinvoices.savedFolders);
    return

    const folders = fetchFolders(savedinvoices.savedFolders);

    const blobMap = blobAllFolders(folders);

    const zipedBlobs = zipAllBlobs(blobMap);

    const saved = saveAllZips(zipedBlobs);

    Logger.log(saved)

    t_mailSavedInvoices(MAIL_LIST[MAIL_TO.USER], 'Τιμολόγια', saved);

  }

  return true;
}





function t_mailSavedInvoices(mail_to, subject, saved_files) {

  if (!saved_files || !Array.isArray(saved_files) || saved_files.length === 0) {
    throw new Error("Mailer: No zip files provided.");
  }

  const MAX_TOTAL = 20 * 1024 * 1024; // 20MB safe limit
  const attachments = [];
  let totalSize = 0;

  saved_files.forEach(file => {

    if (!file) return;

    const blob = file.getBlob();
    const size = blob.getBytes().length;

    if (size === 0) {
      console.warn("Mailer: Skipping empty zip:", file.getName());
      return;
    }

    totalSize += size;
    attachments.push(blob);

  });

  if (attachments.length === 0) {
    throw new Error("Mailer: No valid attachments.");
  }

  const body = "Τα τιμολόγια επισυνάπτονται.";

  // ATTACH DIRECTLY
  if (totalSize <= MAX_TOTAL) {

    GmailApp.sendEmail(mail_to, subject, body, {
      attachments: attachments
    });

    // delete temporary zips
    saved_files.forEach(file => {
      try {
        file.setTrashed(true);
      } catch (e) {
        console.warn("Mailer: Could not trash file", file.getName());
      }
    });

    return { mode: "attachment", count: attachments.length };
  }

  // FALLBACK: SHARE DRIVE LINKS
  const links = [];

  saved_files.forEach(file => {
    try {
      file.addViewer(mail_to);
      links.push(file.getUrl());
    } catch (e) {
      console.warn("Mailer: Failed to share file", file.getName());
    }
  });

  GmailApp.sendEmail(
    mail_to,
    subject,
    "Τα αρχεία είναι πολύ μεγάλα για email. Κατεβάστε τα εδώ:\n\n" + links.join("\n")
  );

  return { mode: "drive_links", count: saved_files.length };
}



function saveAllZips(zips) {

  const savedFiles = [];

  for (const [year, folders] of zips.entries()) {

    const parentFolder = createArchive(year, APP_ROOT_FOLDER);

    for (const [folderName, zipBlob] of Object.entries(folders)) {

      if (!zipBlob) continue;

      const childFolder = parentFolder.getFoldersByName(folderName);

      if (!childFolder.hasNext()) continue;

      const childFolderNext = childFolder.next();

      const fileName = zipBlob.getName();

      const existingFile = childFolderNext.getFilesByName(fileName);

      if (existingFile.hasNext()) {
        console.log("Zip already exists, skipping:", fileName);
        continue;
      }

      const file = childFolderNext.createFile(zipBlob);

      savedFiles.push(file);

      console.log("Saved zip:", fileName, "in", childFolderNext.getName());
    }
  }

  return savedFiles;
}

function blobAllFolders(foldersArr) {

  const blobMap = new Map();

  for (const [key, value] of foldersArr.entries()) {

    const folderData = {};

    value.forEach(folder => {

      let blobs = [];

      t_blobInvoices(folder, blobs, folder.getName());

      const folderName = folder.getName();

      folderData[folderName] = blobs;
    });

    blobMap.set(key, folderData);
  }

  return blobMap;
}



function zipAllBlobs(folderMap) {

  const zips = new Map()

  for ([key, values] of folderMap.entries()) {

    const zipsObj = {};

    for ([folder, blobs] of Object.entries(values)) {

      zipsObj[folder] = t_zipBlobs(blobs, folder);
    }

    zips.set(key, zipsObj);
  }

  for ([key, values] of zips.entries()) {

    console.log("ZIP ALL BLOBS: ", "key: ", key, values)

  }

  return zips;
}


//takes object year keys and array of its folders names 
//returns array of appscript folders
function fetchFolders(parentChild) {

  const parentChildMap = new Map();

  for ([key, value] of Object.entries(parentChild)) {

    const parentFolder = APP_ROOT_FOLDER.getFoldersByName(key);


    if (parentFolder.hasNext()) {

      const parentFoldersNext = parentFolder.next();

      if (!parentChildMap.has(parentFoldersNext.getName()))
            parentChildMap.set(parentFoldersNext.getName(), []);

      value.forEach(child => {

        const childFolder = parentFoldersNext.getFoldersByName(child);

        if (childFolder.hasNext()) {

          return parentChildMap.get(parentFoldersNext.getName()).push(childFolder.next());

        } else {

          throw Error("fetchFolders: child doesnt exist")
        }
      });

    } else {

      throw Error("fetchFolders: Parent doesnt exist")
    }

  }

  return parentChildMap;
}



function t_zipBlobs(blobs, folder_name) {

  if (blobs.length === 0)
    throw Error(`zipBlob: Error blob array is empty`);

  const zip = Utilities.zip(blobs, folder_name.endsWith('.zip') ? folder_name : folder_name + '.zip')

  if (zip.getBytes().length === 0)
    throw Error(`zipBlob: Error couldnt zip files for ${folder_name}`);


  return zip;

}



function t_blobInvoices(folder, blobs, blob_name = '') {

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

    t_blobInvoices(folder, blobs)
  }

  return blobs;
}



function t_getInvoices(exec_params) {

  console.log("t_getInvoices params:", exec_params);

  const threads = t_getInvoicesFromMail(exec_params);

  console.log("threads: ", threads.length)

  const searchTerms = ['τιμολογ', 'invoice', 'παραστατ'].map(normalize_);

  const filteredMails = t_filterMailsByTerms(threads, searchTerms);

  const from_and_attachments = t_filterDuplicateAttachments(filteredMails);

  return from_and_attachments;

}



function t_getInvoicesFromMail(params) {

  const base = "in:anywhere has:attachment filename:pdf";

  if (params.fetch_type === FETCH_TYPE.MONTH_YEAR) {

    const tz = Session.getScriptTimeZone();

    const fmt = d => Utilities.formatDate(d, tz, "yyyy/MM/dd");

    // Loop through the targets array to build individual date queries
    const queries = params.month_year.map(target => {

      let year = Number(target.year);

      let month = Number(target.month);

      month = month === 0 ? new Date().getMonth() + 1 : month;

      year = year === 0 ? new Date().getFullYear() : year;

      if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {

        throw new Error('Month filter must be an integer 1-12.');
      }

      const start = new Date(year, month - 1, 1);

      const end = new Date(year, month, 1);

      return `(after:${fmt(start)} before:${fmt(end)})`;
    });

    // Combine them with OR syntax { query1 query2 }
    const finalQuery = `${base} { ${queries.join(" ")} }`;

    return GmailApp.search(finalQuery);
  }

  // Handle NEWER_THAN logic (unchanged)
  const days = params.newer_than;

  const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;

  const query = `${base} newer_than:${safeDays}d`;

  return GmailApp.search(query);
}


function t_saveInvoices(invoices, exec_params) {

  const savedObject = {};

  const savedFoldersMap = new Map();

  const exec_type = exec_params.fetch_type;

  switch (exec_type) {

    case FETCH_TYPE.NEWER_THAN:

      const newerThanArchiveName = getExecTypeArchiveName(exec_params);

      const newerThanParent = createArchive(FETCH_TYPE.NEWER_THAN, APP_ROOT_FOLDER);

      invoices.forEach(child => {

        const dateArchive = createArchive(newerThanArchiveName, newerThanParent);

        const sender_folder = createSenderFolder(dateArchive, child.from);

        saveToFolder(child.invoice, sender_folder, child.month);
      });
      break;

    case FETCH_TYPE.MONTH_YEAR:

      invoices.forEach(child => {

        const folder_name = folderNameFromMonth(child.month, child.year);

        const year_str = child.year.toString();

        if (!savedFoldersMap.has(year_str)) {

          savedFoldersMap.set(year_str, new Set());
        }
        savedFoldersMap.get(year_str).add(folder_name);


        const parentArchive = createArchive(year_str, APP_ROOT_FOLDER);

        const dateArchive = createArchive(folder_name, parentArchive);

        const sender_folder = createSenderFolder(dateArchive, child.from);

        saveToFolder(child.invoice, sender_folder, child.month);
      });

      savedFoldersMap.forEach((folderSet, year) => {

        savedObject[year] = Array.from(folderSet);
      });

      break;
  }

  return { ok: true, savedFolders: savedObject };
}




function t_filterMailsByTerms(threads, searchTerms) {

  try {

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

  } catch (e) {

    console.log('filter error: ', e.message)

  }
}



function t_filterDuplicateAttachments(mailMap) {

  const seenStrict = new Set();

  const pdf = [];

  try {
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

  } catch (e) {

    console.log('strong filtering err:', e.message)
  }
}




