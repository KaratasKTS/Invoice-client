'use strict';
// The local archive: a mirror of the Drive tree on disk.
//
//   <archiveDir>/<year>/<month folder>/<sender>/<file>
//
// Drive names can contain characters that Windows does not allow, so names are
// cleaned up before they touch the disk. `.index.json` remembers which Drive
// file each local file came from and the original names of the month folders.

const fs = require('node:fs');
const path = require('node:path');

const INDEX_FILE = '.index.json';
const MAX_NAME_LENGTH = 150;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const KINDS = {
  '.pdf': 'pdf',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.txt': 'text', '.csv': 'text', '.log': 'text',
};

/** Makes a Drive name safe as a file or folder name on Windows, macOS and Linux. */
function sanitizeName(name) {
  let out = String(name === undefined || name === null ? '' : name)
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .replace(/^\./, '_');   // dot files are hidden and reserved for the index

  if (out === '' || out === '.' || out === '..') out = '_';
  if (RESERVED_NAMES.test(out)) out = '_' + out;

  if (out.length > MAX_NAME_LENGTH) {
    const ext = path.extname(out).slice(0, 12);
    out = out.slice(0, MAX_NAME_LENGTH - ext.length).replace(/[. ]+$/, '') + ext;
  }
  return out;
}

/** "invoice.pdf", 2 -> "invoice (2).pdf" */
function withSuffix(name, n) {
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

class Store {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.index = this._loadIndex();
    this._rebuildPathOwners();
  }

  // ---- index -------------------------------------------------------------

  _loadIndex() {
    const empty = { version: 1, files: {}, folders: {} };
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.rootDir, INDEX_FILE), 'utf8'));
      if (!data || typeof data !== 'object') return empty;
      return { version: 1, files: data.files || {}, folders: data.folders || {} };
    } catch (err) {
      return empty;
    }
  }

  _rebuildPathOwners() {
    this.pathOwners = new Map();
    for (const [id, entry] of Object.entries(this.index.files)) this.pathOwners.set(entry.path.toLowerCase(), id);
  }

  /** Writes the index to disk. */
  flush() {
    const target = path.join(this.rootDir, INDEX_FILE);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.index, null, 1));
    fs.renameSync(temp, target);
  }

  // ---- folders -----------------------------------------------------------

  /** Local relative path ("2026/Τιμολόγια_…") of a Drive month folder. */
  folderPath(parentFolder, childFolder) {
    return `${sanitizeName(parentFolder)}/${sanitizeName(childFolder)}`;
  }

  /** Remembers the Drive names behind a local month folder. */
  registerFolder(parentFolder, childFolder) {
    const rel = this.folderPath(parentFolder, childFolder);
    this.index.folders[rel] = { parent_folder: String(parentFolder), child_folder: String(childFolder) };
    return rel;
  }

  /** Deletes the local copy of a month folder. Returns true when something was removed. */
  removeFolder(parentFolder, childFolder) {
    const rel = this.folderPath(parentFolder, childFolder);
    const abs = path.join(this.rootDir, ...rel.split('/'));
    if (!isInside(this.rootDir, abs)) throw new Error('Invalid folder');

    const existed = fs.existsSync(abs);
    fs.rmSync(abs, { recursive: true, force: true });

    for (const [id, entry] of Object.entries(this.index.files)) {
      if (entry.path.startsWith(rel + '/')) delete this.index.files[id];
    }
    delete this.index.folders[rel];
    this._rebuildPathOwners();
    this.flush();

    // drop the year folder when it is now empty
    const yearDir = path.dirname(abs);
    try {
      if (isInside(this.rootDir, yearDir) && fs.readdirSync(yearDir).length === 0) fs.rmdirSync(yearDir);
    } catch (err) { /* not there, nothing to tidy */ }

    return existed;
  }

  /**
   * Deletes single files by their Drive ID, then tidies up folders that became
   * empty. Returns how many files were removed.
   */
  removeFiles(ids) {
    let removed = 0;
    const touchedDirs = new Set();

    for (const id of ids) {
      const entry = this.index.files[id];
      if (!entry) continue;

      const abs = path.join(this.rootDir, ...entry.path.split('/'));
      if (!isInside(this.rootDir, abs)) continue;

      if (fs.existsSync(abs)) {
        fs.rmSync(abs, { force: true });
        removed++;
      }
      delete this.index.files[id];
      touchedDirs.add(path.dirname(abs));
    }

    // Remove empty folders, walking up towards the archive root.
    for (const start of touchedDirs) {
      for (let dir = start; isInside(this.rootDir, dir); dir = path.dirname(dir)) {
        try {
          if (fs.readdirSync(dir).length > 0) break;
          fs.rmdirSync(dir);
          delete this.index.folders[path.relative(this.rootDir, dir).split(path.sep).join('/')];
        } catch (err) {
          break;
        }
      }
    }

    this._rebuildPathOwners();
    this.flush();
    return removed;
  }

  // ---- files -------------------------------------------------------------

  /** True when this Drive file is already on disk, unchanged. */
  hasFile(record) {
    const entry = this.index.files[record.id];
    if (!entry || entry.size !== record.size) return false;
    try {
      return fs.statSync(path.join(this.rootDir, ...entry.path.split('/'))).size === entry.bytes;
    } catch (err) {
      return false;
    }
  }

  /**
   * Saves a Drive file. record = { id, parent_folder, child_folder, sender, name, size }.
   * Returns the local relative path.
   */
  saveFile(record, buffer) {
    const folderRel = this.registerFolder(record.parent_folder, record.child_folder);
    const senderParts = String(record.sender || '').split('/').filter(Boolean).map(sanitizeName);
    const dirRel = [folderRel, ...senderParts].join('/');

    const previous = this.index.files[record.id];
    const baseName = sanitizeName(record.name);

    // Two Drive names can clean up to the same local name: keep both.
    let name = baseName;
    for (let n = 2; ; n++) {
      const owner = this.pathOwners.get(`${dirRel}/${name}`.toLowerCase());
      if (!owner || owner === record.id) break;
      name = withSuffix(baseName, n);
    }

    const rel = `${dirRel}/${name}`;
    const abs = path.join(this.rootDir, ...rel.split('/'));
    if (!isInside(this.rootDir, abs)) throw new Error('Invalid file path');

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const temp = `${abs}.part`;
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, abs);

    if (previous && previous.path !== rel) {
      this.pathOwners.delete(previous.path.toLowerCase());
      fs.rmSync(path.join(this.rootDir, ...previous.path.split('/')), { force: true });
    }

    this.index.files[record.id] = { path: rel, size: record.size, bytes: buffer.length };
    this.pathOwners.set(rel.toLowerCase(), record.id);
    return rel;
  }

  /**
   * Absolute path of a file inside the archive, or null when the relative
   * path is not a plain file under the archive folder.
   */
  resolveFile(relPath) {
    if (typeof relPath !== 'string' || relPath === '') return null;
    const parts = relPath.split('/');
    for (const part of parts) {
      if (part === '' || part === '.' || part === '..') return null;
      if (/[\\:\u0000]/.test(part)) return null;
      if (part.startsWith('.')) return null;
    }

    const abs = path.join(this.rootDir, ...parts);
    if (!isInside(this.rootDir, abs)) return null;

    try {
      const real = fs.realpathSync(abs);
      if (!isInside(fs.realpathSync(this.rootDir), real)) return null;
      return fs.statSync(real).isFile() ? real : null;
    } catch (err) {
      return null;
    }
  }

  /** How a file can be shown: 'pdf', 'image', 'text' or 'other'. */
  static kindOf(absPath) {
    const kind = KINDS[path.extname(absPath).toLowerCase()];
    if (kind) return kind;
    try {
      const fd = fs.openSync(absPath, 'r');
      const head = Buffer.alloc(5);
      fs.readSync(fd, head, 0, 5, 0);
      fs.closeSync(fd);
      return head.toString('latin1') === '%PDF-' ? 'pdf' : 'other';
    } catch (err) {
      return 'other';
    }
  }

  // ---- tree --------------------------------------------------------------

  /**
   * The archive as nested nodes:
   *   { name, path, type: 'dir', children, drive? } | { name, path, type: 'file', size, modified, kind }
   * Month folders (second level) carry `drive` with their Drive names.
   */
  tree() {
    const walk = (absDir, relDir, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch (err) {
        return [];
      }

      const nodes = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.endsWith('.part')) continue;
        const abs = path.join(absDir, entry.name);
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          const node = { name: entry.name, path: rel, type: 'dir', children: walk(abs, rel, depth + 1) };
          if (depth === 1) {
            node.drive = this.index.folders[rel] || { parent_folder: relDir, child_folder: entry.name };
          }
          nodes.push(node);
        } else if (entry.isFile()) {
          const stat = fs.statSync(abs);
          nodes.push({ name: entry.name, path: rel, type: 'file', size: stat.size, modified: stat.mtimeMs, kind: Store.kindOf(abs) });
        }
      }

      nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'el', { numeric: true }) : a.type === 'dir' ? -1 : 1));
      return nodes;
    };

    return walk(this.rootDir, '', 0);
  }
}

module.exports = { Store, sanitizeName, withSuffix };
