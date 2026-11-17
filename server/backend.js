'use strict';
// Talks to the Apps Script web app. Every request is signed with the key:
// HMAC-SHA256 over "ts.exec_type.body".

const crypto = require('node:crypto');

class BackendError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BackendError';
    this.code = code || 'REJECTED';
  }
}

// Answers of the script that mean the connection itself is set up wrong.
const SETUP_ERRORS = {
  'Invalid signature': ['BAD_KEY', 'Ο μυστικός κωδικός δεν ταιριάζει με την υπηρεσία, ή η διεύθυνση δείχνει σε παλιά έκδοσή της. Έλεγξέ τα στις Ρυθμίσεις.'],
  'Expired': ['CLOCK', 'Η ώρα του υπολογιστή φαίνεται λάθος. Διόρθωσέ την και δοκίμασε ξανά.'],
  'Server not configured': ['BAD_KEY', 'Η υπηρεσία στο Google δεν έχει μυστικό κωδικό ακόμα (API_SECRET στο Apps Script).'],
};

// Other answers of the script, put into plain Greek.
const TRANSLATIONS = [
  [/^Folder "(.+)" was not found$/, (m) => `Ο φάκελος «${m[1]}» δεν βρέθηκε στο Google Drive.`],
  [/^Folder "(.+)" has no files to send$/, (m) => `Ο φάκελος «${m[1]}» δεν έχει αρχεία για αποστολή.`],
  [/^Could not zip the files/, () => 'Δεν ήταν δυνατή η συμπίεση των αρχείων του φακέλου.'],
  [/^mail_to must be/, () => 'Η διεύθυνση email δεν είναι έγκυρη.'],
  [/^newer_than must be/, () => 'Οι ημέρες πρέπει να είναι αριθμός από 1 έως 90.'],
  [/^month must be/, () => 'Ο μήνας δεν είναι έγκυρος.'],
  [/^year must be/, () => 'Το έτος δεν είναι έγκυρο.'],
  [/^Unknown action/, () => 'Η υπηρεσία στο Google είναι παλιότερης έκδοσης και δεν υποστηρίζει αυτή την ενέργεια.'],
  [/^File is too large/, () => 'Το αρχείο είναι πολύ μεγάλο για να κατέβει.'],
  [/^File is not part of the invoice archive$/, () => 'Το αρχείο δεν ανήκει στον φάκελο των τιμολογίων.'],
];

/** A message of the script in Greek, for showing to the user. */
function translate(message) {
  for (const [pattern, toGreek] of TRANSLATIONS) {
    const match = pattern.exec(message);
    if (match) return toGreek(match);
  }
  return `Η υπηρεσία ανέφερε πρόβλημα: ${message}`;
}

function sign(key, ts, execType, body) {
  return crypto.createHmac('sha256', key).update(`${ts}.${execType}.${body}`, 'utf8').digest('hex');
}

function cancelled() {
  return new BackendError('Η ενέργεια διακόπηκε.', 'CANCELLED');
}

/**
 * @param {{getUrl: () => string, getKey: () => string|null, timeoutMs?: number}} options
 *   The URL and key are read on every call, so changes in Settings apply at once.
 */
function createBackend({ getUrl, getKey, timeoutMs = 7 * 60 * 1000 }) {

  /**
   * Runs one backend action and returns its return_value, or throws BackendError.
   * options.signal (AbortSignal) stops waiting for the answer.
   */
  async function call(execType, params = {}, { signal } = {}) {
    const key = getKey();
    const url = getUrl();
    if (!url) throw new BackendError('Δεν έχει οριστεί η διεύθυνση της υπηρεσίας. Πρόσθεσέ τη στις Ρυθμίσεις.', 'NO_URL');
    if (!key) throw new BackendError('Δεν έχει οριστεί ο μυστικός κωδικός. Πρόσθεσέ τον στις Ρυθμίσεις.', 'NO_KEY');
    if (signal && signal.aborted) throw cancelled();

    const body = JSON.stringify(params);
    const ts = String(Math.floor(Date.now() / 1000));
    const query = `ts=${ts}&sig=${sign(key, ts, execType, body)}&exec_type=${encodeURIComponent(execType)}`;
    const target = `${url}${url.includes('?') ? '&' : '?'}${query}`;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onCancel = () => controller.abort();
    if (signal) signal.addEventListener('abort', onCancel, { once: true });

    let response;
    let text;
    try {
      response = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        redirect: 'follow',
        signal: controller.signal,
      });
      text = await response.text();
    } catch (err) {
      if (signal && signal.aborted) throw cancelled();
      if (timedOut) throw new BackendError('Η υπηρεσία άργησε πολύ να απαντήσει. Δοκίμασε ξανά.', 'NETWORK');
      throw new BackendError('Δεν ήταν δυνατή η σύνδεση με την υπηρεσία. Έλεγξε τη σύνδεσή σου στο internet και τη διεύθυνση στις Ρυθμίσεις.', 'NETWORK');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onCancel);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new BackendError('Η υπηρεσία δεν απάντησε όπως αναμενόταν. Έλεγξε ότι η διεύθυνση στις Ρυθμίσεις είναι σωστή.', 'BAD_RESPONSE');
    }

    if (!json || json.ok !== true) {
      const message = String((json && (json.error || json.return_value)) || 'unknown error');
      const setup = SETUP_ERRORS[message];
      if (setup) throw new BackendError(setup[1], setup[0]);
      throw new BackendError(translate(message), 'REJECTED');
    }

    return json.return_value;
  }

  return { call };
}

module.exports = { createBackend, BackendError, sign, translate };
