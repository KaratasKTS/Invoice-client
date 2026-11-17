'use strict';
// Settings come from config.json next to the scripts, with environment
// variables on top (used by the tests and the mock backend).

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..');

function loadConfig(env = process.env, rootDir = ROOT_DIR) {
  let file = {};
  const configPath = path.join(rootDir, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      throw new Error(`config.json is not valid JSON: ${err.message}`);
    }
  }

  const port = Number(env.INVOICE_PORT || file.port || 4780);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The port in config.json must be 1-65535');

  return {
    rootDir,
    url: String(env.INVOICE_URL || file.url || ''),
    port,
    archiveDir: path.resolve(rootDir, env.INVOICE_ARCHIVE_DIR || file.archiveDir || 'archives'),
    keyFile: path.resolve(rootDir, env.INVOICE_KEY_FILE || 'key'),
    webDir: path.join(rootDir, 'web'),
  };
}

/** The API secret, or null when the key file is missing or empty. Line endings are ignored. */
function readKey(keyFile) {
  try {
    const key = fs.readFileSync(keyFile, 'utf8').replace(/[\r\n]/g, '');
    return key || null;
  } catch (err) {
    return null;
  }
}

module.exports = { loadConfig, readKey, ROOT_DIR };
