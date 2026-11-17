'use strict';
// Talks to the Apps Script web app. Every request is signed with the key:
// HMAC-SHA256 over "ts.exec_type.body".

const crypto = require('node:crypto');

class BackendError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BackendError';
    this.code = code || 'BACKEND';
  }
}

const HINTS = {
  'Invalid signature': 'Invalid signature: the key file does not match the API_SECRET of the script, or the Apps Script deployment still runs the old code.',
  'Expired': 'The backend rejected the request time. Check that the clock of this computer is correct.',
  'Server not configured': 'The Apps Script has no API_SECRET script property.',
};

function sign(key, ts, execType, body) {
  return crypto.createHmac('sha256', key).update(`${ts}.${execType}.${body}`, 'utf8').digest('hex');
}

/**
 * @param {{url: string, getKey: () => string|null, timeoutMs?: number}} options
 */
function createBackend({ url, getKey, timeoutMs = 7 * 60 * 1000 }) {

  /** Runs one backend action and returns its return_value, or throws BackendError. */
  async function call(execType, params = {}) {
    const key = getKey();
    if (!key) throw new BackendError('The key file is missing or empty. Put the API secret in a file named "key" next to start.sh.', 'NO_KEY');
    if (!url) throw new BackendError('No backend URL. Set "url" in config.json.', 'NO_URL');

    const body = JSON.stringify(params);
    const ts = String(Math.floor(Date.now() / 1000));
    const target = `${url}?ts=${ts}&sig=${sign(key, ts, execType, body)}&exec_type=${encodeURIComponent(execType)}`;

    let response;
    let text;
    try {
      response = await fetch(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? 'it took too long to answer' : (err.cause && err.cause.message) || err.message;
      throw new BackendError(`Could not reach the backend: ${reason}`, 'NETWORK');
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new BackendError(
        `The backend did not answer with JSON (HTTP ${response.status}). Check the URL in config.json and that the web app is deployed.`,
        'BAD_RESPONSE');
    }

    if (!json || json.ok !== true) {
      const message = String((json && (json.error || json.return_value)) || 'The backend reported an error');
      throw new BackendError(HINTS[message] || message, 'REJECTED');
    }

    return json.return_value;
  }

  return { call };
}

module.exports = { createBackend, BackendError, sign };
