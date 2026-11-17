'use strict';
// Invoice client page. Talks only to the local server it was loaded from.
// Everything the user reads is in Greek.

(() => {
  const TOKEN = document.querySelector('meta[name="session-token"]').content;

  const MONTHS = ['Ιανουάριος', 'Φεβρουάριος', 'Μάρτιος', 'Απρίλιος', 'Μάιος', 'Ιούνιος',
    'Ιούλιος', 'Αύγουστος', 'Σεπτέμβριος', 'Οκτώβριος', 'Νοέμβριος', 'Δεκέμβριος'];

  const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

  const $ = (id) => document.getElementById(id);

  const state = {
    tree: [],            // local archive, as sent by the server
    remote: null,        // { "<year>": ["<month folder>"] } from Drive, null while unknown
    remoteError: null,
    hasKey: true,
    hasUrl: true,
    accountantEmail: '',
    model: { years: [], months: new Map(), files: [] },
    expanded: loadExpanded(),
    selection: null,     // { type: 'folder', key } | { type: 'file', path }
    job: null,           // the running fetch or download, if any
    busy: false,
  };

  let shownContent = null;   // what the content pane currently shows, to avoid reloading a PDF
  let loggedLines = 0;       // log lines of the current job already copied to the activity log
  let bannerHandler = null;
  let openedNewestYear = false;

  // ---- small helpers -----------------------------------------------------

  /** Creates an element. Text always goes in as text, never as HTML. */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child);
    }
    return el;
  }

  /** "1 αρχείο" / "3 αρχεία" */
  function count(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  const files = (n) => count(n, 'αρχείο', 'αρχεία');

  /** Chooses the singular or plural wording of a whole phrase. */
  const pick = (n, one, many) => (n === 1 ? one : many);

  function formatSize(bytes) {
    const number = (value, digits) => value.toLocaleString('el-GR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${number(bytes / 1024, bytes < 10240 ? 1 : 0)} KB`;
    return `${number(bytes / 1024 / 1024, 1)} MB`;
  }

  function fileUrl(path, download) {
    return '/files/' + path.split('/').map(encodeURIComponent).join('/') + (download ? '?download=1' : '');
  }

  function loadExpanded() {
    try {
      return new Set(JSON.parse(localStorage.getItem('invoice-client.expanded') || '[]'));
    } catch (err) {
      return new Set();
    }
  }

  function saveExpanded() {
    try {
      localStorage.setItem('invoice-client.expanded', JSON.stringify([...state.expanded]));
    } catch (err) { /* private mode: the tree simply starts collapsed next time */ }
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { 'X-Session-Token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error('Το πρόγραμμα δεν απαντά. Ξεκίνησέ το ξανά (start.sh ή start.bat) και κάνε ανανέωση της σελίδας.');
    }
    let data = null;
    try { data = await res.json(); } catch (err) { /* handled below */ }
    if (!res.ok) throw new Error((data && data.error) || 'Κάτι πήγε στραβά. Δοκίμασε ξανά.');
    return data;
  }

  // ---- toasts and activity log -------------------------------------------

  function toast(message, kind) {
    const el = h('div', { class: 'toast' + (kind === 'error' ? ' error' : ''), role: kind === 'error' ? 'alert' : 'status', text: message });
    $('toasts').append(el);
    while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
    setTimeout(() => el.remove(), kind === 'error' ? 10000 : 5000);
  }

  function logLine(message, level, time) {
    const stamp = new Date(time || Date.now()).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const list = $('activity-log');
    list.append(h('li', { class: level || 'info' }, h('time', { text: stamp }), h('span', { text: message })));
    while (list.children.length > 400) list.firstChild.remove();
    list.scrollTop = list.scrollHeight;
  }

  function setActivity(text, status, progress) {
    $('activity-text').textContent = text;
    $('activity-dot').className = 'dot' + (status ? ' ' + status : '');
    const bar = $('activity-progress');
    if (progress && progress.total > 0) {
      bar.hidden = false;
      bar.max = progress.total;
      bar.value = progress.done;
    } else if (status === 'running') {
      bar.hidden = false;
      bar.removeAttribute('value');
    } else {
      bar.hidden = true;
    }
  }

  function showLog(open) {
    $('activity-log').hidden = !open;
    $('activity-toggle').textContent = open ? 'Απόκρυψη ιστορικού' : 'Εμφάνιση ιστορικού';
    $('activity-toggle').setAttribute('aria-expanded', String(open));
    if (open) $('activity-log').scrollTop = $('activity-log').scrollHeight;
  }

  function fail(err) {
    const message = err && err.message ? err.message : String(err);
    toast(message, 'error');
    logLine(message, 'error');
    setActivity(message, 'error');
  }

  // ---- model: local tree + Drive folder list -----------------------------

  function monthKey(parent, child) {
    return JSON.stringify([parent, child]);
  }

  function parseMonthFolder(parent, child) {
    const m = /^Τιμολόγια_(.+)_(\d{4})$/.exec(child);
    if (!m || m[2] !== parent) return null;
    const index = MONTHS.indexOf(m[1]);
    return index === -1 ? null : { index, name: m[1] };
  }

  /** Friendly name of a year-level folder. */
  function yearLabel(name) {
    return name === 'NEWER_THAN' ? 'Παλιές λήψεις ανά ημέρες' : name;
  }

  function buildModel() {
    const years = new Map();
    const months = new Map();
    const allFiles = [];

    const yearOf = (name) => {
      if (!years.has(name)) years.set(name, { name, label: yearLabel(name), months: [] });
      return years.get(name);
    };

    const addMonth = (parent, child) => {
      const key = monthKey(parent, child);
      if (months.has(key)) return months.get(key);
      const parsed = parseMonthFolder(parent, child);
      const plain = child.replace(/^Τιμολόγια_/, '');
      const month = {
        key, parent, child,
        label: parsed ? parsed.name : plain,                         // in the tree, under its year
        title: parsed ? `${parsed.name} ${parent}` : plain,          // on its own
        order: parsed ? parsed.index : -1,
        local: false, inDrive: null, path: null,
        senders: [], files: [], size: 0,
      };
      months.set(key, month);
      yearOf(parent).months.push(month);
      return month;
    };

    for (const yearNode of state.tree) {
      if (yearNode.type !== 'dir') continue;
      for (const monthNode of yearNode.children) {
        if (monthNode.type !== 'dir') continue;
        const month = addMonth(monthNode.drive.parent_folder, monthNode.drive.child_folder);
        month.local = true;
        month.path = monthNode.path;

        const senders = new Map();
        const collect = (node, sender) => {
          for (const child of node.children) {
            if (child.type === 'dir') {
              collect(child, sender ? `${sender}/${child.name}` : child.name);
            } else {
              if (!senders.has(sender)) senders.set(sender, { name: sender, path: `${monthNode.path}/${sender}`, files: [] });
              const file = { name: child.name, path: child.path, size: child.size, kind: child.kind, sender, monthKey: month.key };
              senders.get(sender).files.push(file);
              month.files.push(file);
              month.size += child.size;
            }
          }
        };
        collect(monthNode, '');
        month.senders = [...senders.values()];
      }
    }

    if (state.remote) {
      for (const [parent, children] of Object.entries(state.remote)) {
        for (const child of children) addMonth(parent, child).inDrive = true;
      }
      for (const month of months.values()) if (month.inDrive === null) month.inDrive = false;
    }

    const yearList = [...years.values()];
    const yearRank = (name) => (/^\d{4}$/.test(name) ? Number(name) : -1);
    yearList.sort((a, b) => (yearRank(b.name) - yearRank(a.name)) || a.name.localeCompare(b.name));
    for (const year of yearList) {
      year.months.sort((a, b) => (b.order - a.order) || a.child.localeCompare(b.child, 'el', { numeric: true }));
      for (const month of year.months) allFiles.push(...month.files);
    }

    state.model = { years: yearList, months, files: allFiles };
  }

  // ---- tree --------------------------------------------------------------

  function toggle(key, open) {
    const next = open === undefined ? !state.expanded.has(key) : open;
    if (next) state.expanded.add(key); else state.expanded.delete(key);
    saveExpanded();
  }

  function renderTree() {
    const container = $('tree');
    const { years } = state.model;
    const total = state.model.files.length;

    $('tree-status').textContent = total ? files(total) : '';

    if (years.length === 0) {
      const loading = state.remote === null && !state.remoteError;
      container.replaceChildren(h('div', { class: 'tree-empty', text: loading ? 'Φόρτωση…' : 'Δεν υπάρχει τίποτα ακόμα.' }));
      return;
    }

    const isSelectedFolder = (month) => state.selection && state.selection.type === 'folder' && state.selection.key === month.key;
    const isSelectedFile = (file) => state.selection && state.selection.type === 'file' && state.selection.path === file.path;

    const fileRow = (file) => h('li', {},
      h('button', {
        type: 'button', class: 'tree-row file' + (isSelectedFile(file) ? ' selected' : ''), title: file.name,
        'data-path': file.path, onclick: () => selectFile(file.path),
      }, h('span', { class: 'file-icon', 'aria-hidden': 'true' }), h('span', { class: 'label', text: file.name })));

    const senderRow = (sender) => {
      if (sender.name === '') return sender.files.map(fileRow);
      const key = 's:' + sender.path;
      const open = state.expanded.has(key);
      return h('li', {},
        h('button', {
          type: 'button', class: 'tree-row sender', 'aria-expanded': String(open), title: `Αποστολέας: ${sender.name}`,
          onclick: () => { toggle(key); renderTree(); },
        }, h('span', { class: 'chevron', 'aria-hidden': 'true' }), h('span', { class: 'label', text: sender.name }), h('span', { class: 'count', text: String(sender.files.length) })),
        open && h('ul', {}, sender.files.map(fileRow)));
    };

    const monthRow = (month) => {
      const key = 'm:' + month.key;
      const open = state.expanded.has(key) && month.local;
      const selected = isSelectedFolder(month);
      return h('li', {},
        h('button', {
          type: 'button',
          class: 'tree-row month' + (selected ? ' selected' : '') + (month.local ? '' : ' remote-only'),
          'aria-expanded': month.local ? String(open) : undefined,
          title: month.title,
          onclick: () => {
            if (selected && month.local) toggle(key); else toggle(key, true);
            selectFolder(month.key);
          },
        },
        h('span', { class: 'chevron' + (month.local ? '' : ' none'), 'aria-hidden': 'true' }),
        h('span', { class: 'label', text: month.label }),
        !month.local && h('span', { class: 'tag', text: 'Μόνο στο Drive' }),
        month.local && month.inDrive === false && h('span', { class: 'tag warn', text: 'Μόνο εδώ' }),
        month.local && h('span', { class: 'count', text: String(month.files.length) })),
        open && h('ul', {}, month.senders.map(senderRow)));
    };

    const yearRow = (year) => {
      const key = 'y:' + year.name;
      const open = state.expanded.has(key);
      const total = year.months.reduce((sum, month) => sum + month.files.length, 0);
      return h('li', {},
        h('button', {
          type: 'button', class: 'tree-row year', 'aria-expanded': String(open),
          onclick: () => { toggle(key); renderTree(); },
        }, h('span', { class: 'chevron', 'aria-hidden': 'true' }), h('span', { class: 'label', text: year.label }), h('span', { class: 'count', text: String(total) })),
        open && h('ul', {}, year.months.map(monthRow)));
    };

    const scroll = container.scrollTop;
    container.replaceChildren(h('ul', {}, years.map(yearRow)));
    container.scrollTop = scroll;
  }

  // Up and down arrows move between the visible rows of the tree.
  $('tree').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...$('tree').querySelectorAll('.tree-row')];
    const index = rows.indexOf(document.activeElement);
    const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });

  // ---- selection ---------------------------------------------------------

  function selectFolder(key) {
    state.selection = { type: 'folder', key };
    render();
  }

  function selectFile(path) {
    const file = state.model.files.find((f) => f.path === path);
    if (!file) return;
    const month = state.model.months.get(file.monthKey);
    toggle('y:' + month.parent, true);
    toggle('m:' + month.key, true);
    if (file.sender) toggle('s:' + `${month.path}/${file.sender}`, true);
    state.selection = { type: 'file', path };
    render();
    const row = [...$('tree').querySelectorAll('.tree-row.file')].find((el) => el.dataset.path === path);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  // ---- content pane ------------------------------------------------------

  function renderContent() {
    const content = $('content');
    const selection = state.selection;

    if (selection && selection.type === 'file') {
      const file = state.model.files.find((f) => f.path === selection.path);
      if (file) {
        const signature = `file:${file.path}:${file.size}`;
        if (shownContent !== signature) {
          content.replaceChildren(viewerFor(file));
          shownContent = signature;
        } else {
          updateViewerNav(file);
        }
        return;
      }
      state.selection = null;
    }

    if (selection && selection.type === 'folder') {
      const month = state.model.months.get(selection.key);
      if (month) {
        shownContent = 'folder:' + month.key;
        content.replaceChildren(folderView(month));
        return;
      }
      state.selection = null;
    }

    shownContent = null;
    content.replaceChildren(emptyState());
  }

  function emptyState() {
    const hasFiles = state.model.files.length > 0;
    const hasFolders = state.model.years.length > 0;
    return h('div', { class: 'empty-state' },
      h('h2', { text: hasFiles ? 'Διάλεξε μήνα ή αρχείο' : hasFolders ? 'Δεν έχει κατέβει τίποτα ακόμα' : 'Δεν υπάρχουν τιμολόγια ακόμα' }),
      h('p', {
        text: hasFiles ? 'Διάλεξε έναν μήνα αριστερά για να δεις τα τιμολόγιά του. Κάνε κλικ σε ένα αρχείο για να ανοίξει εδώ.'
          : hasFolders ? 'Τα τιμολόγιά σου βρίσκονται στο Google Drive. Κατέβασέ τα για να τα βλέπεις εδώ.'
            : 'Ψάξε στο email σου για τιμολόγια για να ξεκινήσεις.',
      }),
      !hasFiles && h('button', {
        type: 'button', class: 'btn primary', disabled: state.busy,
        text: hasFolders ? 'Κατέβασμα όλων από το Drive' : 'Έλεγχος για νέα τιμολόγια',
        onclick: () => (hasFolders ? startSync() : openFetchDialog()),
      }));
  }

  function neighbours(file) {
    const list = state.model.files;
    const index = list.findIndex((f) => f.path === file.path);
    return { index, total: list.length, previous: list[index - 1] || null, next: list[index + 1] || null };
  }

  function updateViewerNav(file) {
    const nav = neighbours(file);
    const prev = document.querySelector('[data-nav="prev"]');
    const next = document.querySelector('[data-nav="next"]');
    if (prev) prev.disabled = !nav.previous;
    if (next) next.disabled = !nav.next;
    const position = document.querySelector('[data-nav="position"]');
    if (position) position.textContent = `${nav.index + 1} από ${nav.total}`;
  }

  /** Shows one file inside the page: PDFs in a frame, images and text inline. */
  function viewerFor(file) {
    const month = state.model.months.get(file.monthKey);
    const nav = neighbours(file);

    let body;
    if (file.kind === 'pdf') {
      body = h('iframe', { src: fileUrl(file.path), title: file.name });
    } else if (file.kind === 'image') {
      body = h('div', { class: 'image-wrap' }, h('img', { src: fileUrl(file.path), alt: file.name }));
    } else if (file.kind === 'text') {
      body = h('pre', { text: 'Φόρτωση…' });
      fetch(fileUrl(file.path)).then((res) => res.text()).then((text) => { body.textContent = text; })
        .catch(() => { body.textContent = 'Το αρχείο δεν μπόρεσε να ανοίξει.'; });
    } else {
      body = h('div', { class: 'empty-state' },
        h('h2', { text: 'Αυτό το αρχείο δεν μπορεί να προβληθεί εδώ' }),
        h('p', { text: 'Μπορείς να αποθηκεύσεις ένα αντίγραφο και να το ανοίξεις με άλλο πρόγραμμα.' }),
        h('a', { class: 'btn', href: fileUrl(file.path, true), download: file.name, text: 'Αποθήκευση αντιγράφου' }));
    }

    return h('div', { class: 'viewer' },
      h('div', { class: 'viewer-head' },
        h('div', { class: 'viewer-title' },
          h('strong', { text: file.name, title: file.name }),
          h('span', { text: [month.title, file.sender].filter(Boolean).join('  ›  ') + `  ·  ${formatSize(file.size)}` })),
        h('span', { class: 'muted', 'data-nav': 'position', text: `${nav.index + 1} από ${nav.total}` }),
        h('button', { type: 'button', class: 'btn small', 'data-nav': 'prev', disabled: !nav.previous, title: 'Προηγούμενο αρχείο', 'aria-label': 'Προηγούμενο αρχείο', text: '‹', onclick: () => stepFile(-1) }),
        h('button', { type: 'button', class: 'btn small', 'data-nav': 'next', disabled: !nav.next, title: 'Επόμενο αρχείο', 'aria-label': 'Επόμενο αρχείο', text: '›', onclick: () => stepFile(1) }),
        h('a', { class: 'btn small', href: fileUrl(file.path, true), download: file.name, text: 'Αποθήκευση αντιγράφου' }),
        h('button', { type: 'button', class: 'btn small', title: 'Πίσω στον μήνα', text: 'Κλείσιμο', onclick: () => selectFolder(file.monthKey) })),
      h('div', { class: 'viewer-body' }, body));
  }

  function stepFile(delta) {
    if (!state.selection || state.selection.type !== 'file') return;
    const list = state.model.files;
    const index = list.findIndex((f) => f.path === state.selection.path);
    const target = list[index + delta];
    if (target) selectFile(target.path);
  }

  function folderView(month) {
    const inDrive = month.inDrive !== false;
    const driveKnown = month.inDrive !== null;
    const folder = { parent_folder: month.parent, child_folder: month.child };
    const busy = state.busy;
    // Only a real calendar month can be searched again in the mailbox.
    const rescannable = month.order >= 0 && /^\d{4}$/.test(month.parent);

    const meta = [];
    if (month.local) {
      meta.push(h('span', { text: `${files(month.files.length)} · ${count(month.senders.length, 'αποστολέας', 'αποστολείς')} · ${formatSize(month.size)}` }));
    }
    if (driveKnown) {
      if (month.inDrive && month.local) meta.push(h('span', { class: 'tag ok', text: 'Στο Drive και σε αυτόν τον υπολογιστή' }));
      if (month.inDrive && !month.local) meta.push(h('span', { class: 'tag', text: 'Μόνο στο Drive, δεν έχει κατέβει' }));
      if (!month.inDrive) meta.push(h('span', { class: 'tag warn', text: 'Μόνο σε αυτόν τον υπολογιστή' }));
    }

    const actions = h('div', { class: 'folder-actions' },
      inDrive && h('button', { type: 'button', class: 'btn', disabled: busy, text: 'Αποστολή με email…', onclick: () => openMailDialog(month) }),
      inDrive && h('button', {
        type: 'button', class: month.local ? 'btn' : 'btn primary', disabled: busy,
        text: month.local ? 'Κατέβασμα όσων λείπουν' : 'Κατέβασμα στον υπολογιστή',
        onclick: () => startSync([folder]),
      }),
      rescannable && h('button', {
        type: 'button', class: 'btn', disabled: busy, text: 'Νέος έλεγχος στο email',
        title: `Ψάχνει ξανά στο email για τιμολόγια του μήνα ${month.title} και αποθηκεύει όσα είναι καινούργια`,
        onclick: () => startJob('/api/fetch', { mode: 'months', months: [{ month: month.order + 1, year: Number(month.parent) }] }),
      }),
      inDrive && h('button', {
        type: 'button', class: 'btn', disabled: busy, text: 'Καθαρισμός συμπιεσμένων αρχείων',
        title: 'Σβήνει από το Drive τα αρχεία zip που έμειναν από παλιές αποστολές', onclick: () => removeZips(month),
      }),
      inDrive && h('button', { type: 'button', class: 'btn danger', disabled: busy, text: 'Διαγραφή από το Drive…', onclick: () => removeArchive(month) }),
      month.local && h('button', { type: 'button', class: 'btn danger', disabled: busy, text: 'Διαγραφή από τον υπολογιστή…', onclick: () => deleteLocal(month) }));

    const groups = month.senders.map((sender) => h('div', { class: 'sender-group' },
      h('h3', { text: sender.name || 'Αρχεία' }),
      sender.files.map((file) => h('button', { type: 'button', class: 'file-row', onclick: () => selectFile(file.path) },
        h('span', { class: 'file-icon', 'aria-hidden': 'true' }),
        h('span', { class: 'name', text: file.name }),
        h('span', { class: 'size', text: formatSize(file.size) })))));

    return h('div', { class: 'folder-view' },
      h('div', { class: 'folder-head' }, h('h2', { text: month.title })),
      h('div', { class: 'folder-meta' }, meta),
      actions,
      groups.length ? groups : h('p', {
        class: 'muted',
        text: month.local ? 'Αυτός ο μήνας δεν έχει αρχεία.' : 'Τα τιμολόγια αυτού του μήνα βρίσκονται στο Drive και δεν έχουν κατέβει ακόμα.',
      }));
  }

  // ---- render ------------------------------------------------------------

  function renderBanner() {
    const banner = $('banner');
    const action = $('banner-action');
    if (!state.hasKey || !state.hasUrl) {
      $('banner-text').textContent = 'Λείπουν στοιχεία σύνδεσης με την υπηρεσία. Συμπλήρωσέ τα στις Ρυθμίσεις για να μπορείς να ψάχνεις και να κατεβάζεις τιμολόγια.';
      action.textContent = 'Άνοιγμα ρυθμίσεων';
      bannerHandler = openSettings;
      action.hidden = false;
      banner.hidden = false;
    } else if (state.remoteError) {
      $('banner-text').textContent = `Οι φάκελοι του Google Drive δεν διαβάστηκαν, γι' αυτό βλέπεις μόνο όσα υπάρχουν σε αυτόν τον υπολογιστή. ${state.remoteError}`;
      action.textContent = 'Δοκιμή ξανά';
      bannerHandler = refresh;
      action.hidden = false;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  function render() {
    buildModel();

    // The first time there is something to show, open the newest year.
    if (!openedNewestYear && state.model.years.length) {
      openedNewestYear = true;
      if (state.expanded.size === 0) toggle('y:' + state.model.years[0].name, true);
    }

    renderBanner();
    renderTree();
    renderContent();
    $('btn-fetch').disabled = state.busy;
    $('btn-sync').disabled = state.busy;
    $('btn-stop').hidden = !state.job;
  }

  // ---- loading -----------------------------------------------------------

  function applyAppState(info) {
    state.hasKey = info.hasKey;
    state.hasUrl = info.hasUrl;
    state.accountantEmail = info.accountantEmail || '';
  }

  async function loadTree() {
    state.tree = (await api('GET', '/api/tree')).tree;
    render();
  }

  async function loadRemote() {
    if (!state.hasKey || !state.hasUrl) {
      state.remote = null;
      state.remoteError = null;
      render();
      return;
    }
    try {
      state.remote = (await api('GET', '/api/remote')).structure;
      state.remoteError = null;
    } catch (err) {
      state.remoteError = err.message;
    }
    render();
  }

  async function reload() {
    try {
      const info = await api('GET', '/api/state');
      applyAppState(info);
      await loadTree();
      await loadRemote();
      return info;
    } catch (err) {
      fail(err);
      return null;
    }
  }

  async function refresh() {
    setActivity('Ανανέωση…', 'running');
    if (await reload()) setActivity('Έτοιμο', '');
  }

  // ---- jobs: long actions that can be stopped ----------------------------

  function setBusy(busy) {
    state.busy = busy;
    render();
  }

  async function startJob(route, body) {
    if (state.busy) return;
    setBusy(true);
    try {
      const { job } = await api('POST', route, body);
      await followJob(job);
    } catch (err) {
      state.job = null;
      state.busy = false;
      render();
      fail(err);
    }
  }

  async function followJob(first) {
    let job = first;
    state.job = job;
    loggedLines = 0;
    $('btn-stop').disabled = false;
    $('btn-stop').textContent = 'Διακοπή';
    render();
    logLine(job.title, 'title', job.startedAt);

    for (;;) {
      for (const line of job.log.slice(loggedLines)) logLine(line.message, line.level, line.time);
      loggedLines = job.log.length;
      const last = job.log.length ? job.log[job.log.length - 1].message : job.title;
      if (job.status !== 'running') break;
      setActivity(last, 'running', job.progress);
      await new Promise((resolve) => setTimeout(resolve, 500));
      job = (await api('GET', `/api/jobs/${job.id}`)).job;
    }

    state.job = null;
    state.busy = false;
    await reload();
    await finishJob(job);
  }

  async function stopJob() {
    if (!state.job) return;
    $('btn-stop').disabled = true;
    $('btn-stop').textContent = 'Γίνεται διακοπή…';
    try {
      await api('POST', `/api/jobs/${state.job.id}/cancel`, {});
    } catch (err) {
      fail(err);
    }
  }

  /** After the user stopped a run: offer to delete what that run saved on this computer. */
  async function finishCancelled(job) {
    const stopped = 'Η ενέργεια σταμάτησε.';
    setActivity(stopped, '');

    if (!job.downloadedCount) {
      toast(`${stopped} Δεν είχε κατέβει κανένα αρχείο.`);
      return;
    }

    const answer = await confirmDialog({
      title: 'Η ενέργεια σταμάτησε',
      message: pick(job.downloadedCount,
        'Μέχρι τη διακοπή κατέβηκε 1 αρχείο σε αυτόν τον υπολογιστή. Θέλεις να διαγραφεί; ',
        `Μέχρι τη διακοπή κατέβηκαν ${job.downloadedCount} αρχεία σε αυτόν τον υπολογιστή. Θέλεις να διαγραφούν; `)
        + 'Τα τιμολόγια που βρέθηκαν παραμένουν στο Google Drive.',
      okLabel: pick(job.downloadedCount, 'Διαγραφή του αρχείου', 'Διαγραφή των αρχείων'),
      cancelLabel: pick(job.downloadedCount, 'Να μείνει', 'Να μείνουν'),
      danger: true,
    });

    if (!answer.ok) {
      const kept = `${stopped} ` + pick(job.downloadedCount,
        'Το 1 αρχείο που κατέβηκε έμεινε στον υπολογιστή.',
        `Τα ${job.downloadedCount} αρχεία που κατέβηκαν έμειναν στον υπολογιστή.`);
      logLine(kept);
      setActivity(kept, '');
      return;
    }

    try {
      const { removed } = await api('POST', `/api/jobs/${job.id}/discard`, {});
      await reload();
      const message = pick(removed,
        'Διαγράφηκε 1 αρχείο που είχε κατέβει πριν από τη διακοπή.',
        `Διαγράφηκαν ${removed} αρχεία που είχαν κατέβει πριν από τη διακοπή.`);
      toast(message);
      logLine(message);
      setActivity(message, '');
    } catch (err) {
      fail(err);
    }
  }

  async function finishJob(job) {
    if (job.status === 'cancelled') {
      await finishCancelled(job);
      return;
    }

    if (job.status === 'error') {
      toast(job.error, 'error');
      setActivity(job.error, 'error');
      return;
    }

    const result = job.result || {};
    let summary;
    if (job.type === 'fetch') {
      if (result.saved === 0 && result.existing === 0) {
        summary = 'Δεν βρέθηκαν τιμολόγια για αυτή την περίοδο.';
      } else if (result.saved === 0 && result.downloaded === 0) {
        summary = `Δεν υπάρχουν νέα τιμολόγια. Και τα ${result.existing} είναι ήδη αποθηκευμένα.`;
      } else {
        const found = result.saved === 0 ? 'Δεν βρέθηκαν νέα τιμολόγια στο email.'
          : pick(result.saved, 'Βρέθηκε 1 νέο τιμολόγιο.', `Βρέθηκαν ${result.saved} νέα τιμολόγια.`);
        const stored = pick(result.downloaded, 'Αποθηκεύτηκε 1 αρχείο', `Αποθηκεύτηκαν ${result.downloaded} αρχεία`);
        summary = `${found} ${stored} στον υπολογιστή.`;
      }
      if (result.mailed) summary += ' ' + pick(result.mailed, 'Σου στάλθηκε 1 email.', `Σου στάλθηκαν ${result.mailed} email.`);
    } else {
      summary = result.downloaded === 0 ? 'Δεν έλειπε κανένα αρχείο. Όλα είναι ήδη στον υπολογιστή.'
        : pick(result.downloaded, 'Κατέβηκε 1 αρχείο.', `Κατέβηκαν ${result.downloaded} αρχεία.`) + ` Υπήρχαν ήδη ${result.alreadyLocal}.`;
    }

    const problems = (result.errors || []).length + (result.failed || []).length;
    if (problems) {
      summary += ` Υπήρξαν ${count(problems, 'πρόβλημα', 'προβλήματα')}, δες το ιστορικό.`;
      showLog(true);
    }

    toast(summary, problems ? 'error' : undefined);
    logLine(summary, problems ? 'error' : 'info');
    setActivity(summary, problems ? 'error' : 'done');

    // Show the most recent month that was touched.
    const touched = (result.folders || []).map((path) => [...state.model.months.values()].find((m) => m.path === path)).filter(Boolean);
    if (touched.length) {
      touched.sort((a, b) => (Number(b.parent) - Number(a.parent)) || (b.order - a.order));
      toggle('y:' + touched[0].parent, true);
      toggle('m:' + touched[0].key, true);
      selectFolder(touched[0].key);
    }
  }

  function startSync(folders) {
    return startJob('/api/sync', folders ? { folders } : {});
  }

  // ---- dialogs -----------------------------------------------------------

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close('cancel'));
  }

  /** Asks the user to confirm. Resolves to { ok, checked }. */
  function confirmDialog({ title, message, okLabel, cancelLabel, danger, option }) {
    const dialog = $('dlg-confirm');
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-ok').textContent = okLabel || 'Εντάξει';
    $('confirm-cancel').textContent = cancelLabel || 'Άκυρο';
    $('confirm-ok').className = danger ? 'btn danger-solid' : 'btn primary';
    $('confirm-option').hidden = !option;
    $('confirm-option-label').textContent = option || '';
    $('confirm-checkbox').checked = false;

    return new Promise((resolve) => {
      dialog.returnValue = 'cancel';
      dialog.addEventListener('close', () => {
        resolve({ ok: dialog.returnValue === 'ok', checked: $('confirm-checkbox').checked });
      }, { once: true });
      dialog.showModal();
    });
  }

  $('confirm-form').addEventListener('submit', (event) => {
    event.preventDefault();
    $('dlg-confirm').close('ok');
  });

  // Fetch dialog

  const fetchChoice = { year: new Date().getFullYear(), months: new Set() };

  function fetchMode() {
    return document.querySelector('input[name="fetch-mode"]:checked').value;
  }

  function renderFetchDialog() {
    const now = new Date();
    const mode = fetchMode();
    $('fetch-months').hidden = mode !== 'months';
    $('fetch-days').hidden = mode !== 'newer_than';
    $('fetch-year').textContent = String(fetchChoice.year);
    $('fetch-year-next').disabled = fetchChoice.year >= now.getFullYear();
    $('fetch-year-prev').disabled = fetchChoice.year <= 2000;

    $('fetch-month-grid').replaceChildren(...MONTHS.map((name, index) => {
      const id = `${fetchChoice.year}-${index + 1}`;
      const future = fetchChoice.year === now.getFullYear() && index > now.getMonth();
      const input = h('input', { type: 'checkbox', disabled: future });
      input.checked = fetchChoice.months.has(id);
      input.addEventListener('change', () => {
        if (input.checked) fetchChoice.months.add(id); else fetchChoice.months.delete(id);
        renderFetchSubmit();
      });
      return h('label', {}, input, h('span', { text: name }));
    }));
    renderFetchSubmit();
  }

  function renderFetchSubmit() {
    const selected = fetchChoice.months.size;
    $('fetch-submit').textContent = fetchMode() === 'months' && selected > 1 ? `Έναρξη για ${selected} μήνες` : 'Έναρξη';
    $('fetch-error').hidden = true;
  }

  function openFetchDialog() {
    const now = new Date();
    fetchChoice.year = now.getFullYear();
    fetchChoice.months = new Set([`${now.getFullYear()}-${now.getMonth() + 1}`]);
    renderFetchDialog();
    $('dlg-fetch').showModal();
  }

  for (const radio of document.querySelectorAll('input[name="fetch-mode"]')) radio.addEventListener('change', renderFetchDialog);
  $('fetch-year-prev').addEventListener('click', () => { fetchChoice.year--; renderFetchDialog(); });
  $('fetch-year-next').addEventListener('click', () => { fetchChoice.year++; renderFetchDialog(); });
  $('fetch-none').addEventListener('click', () => { fetchChoice.months.clear(); renderFetchDialog(); });
  $('fetch-all').addEventListener('click', () => {
    const now = new Date();
    const last = fetchChoice.year === now.getFullYear() ? now.getMonth() + 1 : 12;
    for (let month = 1; month <= last; month++) fetchChoice.months.add(`${fetchChoice.year}-${month}`);
    renderFetchDialog();
  });

  $('fetch-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const inspect = $('fetch-inspect').checked;
    const error = $('fetch-error');
    let body;

    if (fetchMode() === 'months') {
      if (fetchChoice.months.size === 0) {
        error.textContent = 'Διάλεξε τουλάχιστον έναν μήνα.';
        error.hidden = false;
        return;
      }
      body = {
        mode: 'months', inspect,
        months: [...fetchChoice.months].map((id) => ({ year: Number(id.split('-')[0]), month: Number(id.split('-')[1]) })),
      };
    } else {
      const days = Number($('fetch-days-input').value);
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        error.textContent = 'Γράψε έναν ακέραιο αριθμό ημερών από 1 έως 90.';
        error.hidden = false;
        return;
      }
      body = { mode: 'newer_than', newer_than: days, inspect };
    }

    $('dlg-fetch').close('ok');
    startJob('/api/fetch', body);
  });

  // Mail dialog

  let mailTarget = null;

  function mailChoice() {
    return document.querySelector('input[name="mail-to"]:checked').value;
  }

  function showMailError(message) {
    $('mail-error').textContent = message;
    $('mail-error').hidden = false;
  }

  function openMailDialog(month) {
    mailTarget = month;
    $('mail-folder').textContent = month.title;
    $('mail-error').hidden = true;
    $('mail-accountant-label').textContent = state.accountantEmail
      ? `Στον λογιστή μου (${state.accountantEmail})`
      : 'Στον λογιστή μου (δεν έχει οριστεί email)';
    document.querySelector('input[name="mail-to"][value="USER"]').checked = true;
    $('mail-other').hidden = true;
    $('mail-other').value = '';
    $('dlg-mail').showModal();
  }

  for (const radio of document.querySelectorAll('input[name="mail-to"]')) {
    radio.addEventListener('change', () => {
      const other = mailChoice() === 'OTHER';
      $('mail-other').hidden = !other;
      $('mail-error').hidden = true;
      if (other) $('mail-other').focus();
    });
  }

  $('mail-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const month = mailTarget;
    let mailTo = mailChoice();
    let who = 'σε εσένα';

    if (mailTo === 'ACCOUNTANT') {
      if (!state.accountantEmail) {
        showMailError('Δεν έχεις ορίσει email λογιστή. Πρόσθεσέ το από το κουμπί «Ρυθμίσεις».');
        return;
      }
      who = `στον λογιστή σου (${state.accountantEmail})`;
    } else if (mailTo === 'OTHER') {
      mailTo = $('mail-other').value.trim();
      who = `στο ${mailTo}`;
      if (!EMAIL_PATTERN.test(mailTo)) {
        showMailError('Γράψε μια έγκυρη διεύθυνση email, π.χ. onoma@example.com');
        return;
      }
    }

    $('dlg-mail').close('ok');

    if (mailTo === 'ACCOUNTANT') {
      const answer = await confirmDialog({
        title: 'Αποστολή στον λογιστή;',
        message: `Τα τιμολόγια του μήνα ${month.title} θα σταλούν ${who} ως συμπιεσμένο αρχείο.`,
        okLabel: 'Αποστολή στον λογιστή',
      });
      if (!answer.ok) return;
    }

    await runAction(`Αποστολή του μήνα ${month.title} ${who}…`, async () => {
      const { result } = await api('POST', '/api/mail', { parent_folder: month.parent, child_folder: month.child, mail_to: mailTo });
      return result.mode === 'drive_link'
        ? `Το συμπιεσμένο αρχείο ήταν πολύ μεγάλο για email, γι' αυτό στάλθηκε ${who} ένας σύνδεσμος του Drive.`
        : `Ο μήνας ${month.title} στάλθηκε ${who} (${files(result.files)}).`;
    });
  });

  // Settings dialog

  function showSettingsResult(message, ok) {
    const el = $('settings-result');
    el.textContent = message;
    el.className = 'form-result ' + (ok ? 'ok' : 'error');
    el.hidden = false;
  }

  function fillSettings(settings) {
    $('settings-url').value = settings.url;
    $('settings-accountant').value = settings.accountantEmail;
    $('settings-key').value = '';
    $('settings-key').placeholder = settings.hasKey ? '•••••••• (αποθηκευμένος)' : '';
    $('settings-key-help').textContent = settings.hasKey
      ? 'Υπάρχει ήδη αποθηκευμένος κωδικός. Άφησε το πεδίο κενό για να μείνει ο ίδιος.'
      : 'Ο ίδιος κωδικός που έχει οριστεί στην υπηρεσία στο Google (API_SECRET). Χωρίς αυτόν δεν γίνεται σύνδεση.';
    $('settings-file').textContent = `Οι ρυθμίσεις αποθηκεύονται στο αρχείο ${settings.file}`;
  }

  async function openSettings() {
    try {
      const { settings } = await api('GET', '/api/settings');
      fillSettings(settings);
      $('settings-result').hidden = true;
      $('settings-key-show').checked = false;
      $('settings-key').type = 'password';
      $('dlg-settings').returnValue = 'cancel';
      $('dlg-settings').showModal();
    } catch (err) {
      fail(err);
    }
  }

  /** Saves what is typed in the settings form. Throws with a message for the user. */
  async function saveSettings() {
    const { settings } = await api('POST', '/api/settings', {
      url: $('settings-url').value,
      accountantEmail: $('settings-accountant').value,
      key: $('settings-key').value,
    });
    fillSettings(settings);
    state.hasKey = settings.hasKey;
    state.hasUrl = !!settings.url;
    state.accountantEmail = settings.accountantEmail;
    return settings;
  }

  $('settings-key-show').addEventListener('change', () => {
    $('settings-key').type = $('settings-key-show').checked ? 'text' : 'password';
  });

  $('settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await saveSettings();
    } catch (err) {
      showSettingsResult(err.message, false);
      return;
    }
    $('dlg-settings').close('ok');
    toast('Οι ρυθμίσεις αποθηκεύτηκαν.');
    logLine('Οι ρυθμίσεις αποθηκεύτηκαν.');
    await refresh();
  });

  $('settings-test').addEventListener('click', async () => {
    const button = $('settings-test');
    button.disabled = true;
    showSettingsResult('Γίνεται έλεγχος…', true);
    try {
      await saveSettings();
      const { result } = await api('POST', '/api/settings/test', {});
      showSettingsResult(`Η σύνδεση λειτουργεί. Βρέθηκαν ${count(result.folders, 'φάκελος', 'φάκελοι')} τιμολογίων στο Google Drive.`, true);
    } catch (err) {
      showSettingsResult(err.message, false);
    } finally {
      button.disabled = false;
    }
  });

  $('dlg-settings').addEventListener('close', () => {
    // Settings may have been saved by "Έλεγχος σύνδεσης" even when the dialog is cancelled.
    if ($('dlg-settings').returnValue !== 'ok') reload();
  });

  // ---- month actions -----------------------------------------------------

  /** Runs a short action with the buttons disabled and reports the outcome. */
  async function runAction(label, action, { refreshAfter = false } = {}) {
    if (state.busy) return;
    setBusy(true);
    setActivity(label, 'running');
    logLine(label);
    try {
      const message = await action();
      state.busy = false;
      if (refreshAfter) await reload(); else render();
      toast(message);
      logLine(message);
      setActivity(message, 'done');
    } catch (err) {
      state.busy = false;
      render();
      fail(err);
    }
  }

  async function removeZips(month) {
    const answer = await confirmDialog({
      title: 'Καθαρισμός συμπιεσμένων αρχείων;',
      message: `Τα συμπιεσμένα αρχεία (zip) του μήνα ${month.title} θα μεταφερθούν στον κάδο του Drive. Τα τιμολόγια δεν επηρεάζονται.`,
      okLabel: 'Καθαρισμός',
      danger: true,
    });
    if (!answer.ok) return;
    await runAction(`Καθαρισμός συμπιεσμένων αρχείων του μήνα ${month.title}…`, async () => {
      const { result } = await api('POST', '/api/remove-zips', { parent_folder: month.parent, child_folder: month.child });
      return result.removed
        ? `${count(result.removed, 'συμπιεσμένο αρχείο μεταφέρθηκε', 'συμπιεσμένα αρχεία μεταφέρθηκαν')} στον κάδο του Drive.`
        : 'Δεν υπήρχαν συμπιεσμένα αρχεία σε αυτόν τον μήνα.';
    });
  }

  async function removeArchive(month) {
    const answer = await confirmDialog({
      title: 'Διαγραφή από το Google Drive;',
      message: `Ο μήνας ${month.title} με όλα τα τιμολόγιά του θα μεταφερθεί στον κάδο του Drive. Μπορείς να τον επαναφέρεις από εκεί για 30 ημέρες.`,
      okLabel: 'Διαγραφή από το Drive',
      danger: true,
      option: month.local ? 'Να διαγραφεί και από αυτόν τον υπολογιστή' : null,
    });
    if (!answer.ok) return;
    await runAction(`Διαγραφή του μήνα ${month.title} από το Drive…`, async () => {
      const { result } = await api('POST', '/api/remove-archive', { parent_folder: month.parent, child_folder: month.child, delete_local: answer.checked });
      return result.localRemoved
        ? `Ο μήνας ${month.title} διαγράφηκε από το Drive και από αυτόν τον υπολογιστή.`
        : `Ο μήνας ${month.title} μεταφέρθηκε στον κάδο του Drive.`;
    }, { refreshAfter: true });
  }

  async function deleteLocal(month) {
    const onlyCopy = month.inDrive === false;
    const answer = await confirmDialog({
      title: 'Διαγραφή από τον υπολογιστή;',
      message: onlyCopy
        ? `Ο μήνας ${month.title} δεν υπάρχει πια στο Drive. Αν τον διαγράψεις από εδώ, χάνεται και το τελευταίο αντίγραφο.`
        : `Ο μήνας ${month.title} θα διαγραφεί από αυτόν τον υπολογιστή. Παραμένει στο Drive και μπορείς να τον κατεβάσεις ξανά.`,
      okLabel: 'Διαγραφή από τον υπολογιστή',
      danger: true,
    });
    if (!answer.ok) return;
    await runAction(`Διαγραφή του μήνα ${month.title} από τον υπολογιστή…`, async () => {
      await api('POST', '/api/delete-local', { parent_folder: month.parent, child_folder: month.child });
      return `Ο μήνας ${month.title} διαγράφηκε από αυτόν τον υπολογιστή.`;
    }, { refreshAfter: true });
  }

  // ---- wiring ------------------------------------------------------------

  $('btn-fetch').addEventListener('click', openFetchDialog);
  $('btn-sync').addEventListener('click', () => startSync());
  $('btn-refresh').addEventListener('click', refresh);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-stop').addEventListener('click', stopJob);
  $('banner-action').addEventListener('click', () => { if (bannerHandler) bannerHandler(); });
  $('activity-toggle').addEventListener('click', () => showLog($('activity-log').hidden));

  async function init() {
    render();
    let info;
    try {
      info = await api('GET', '/api/state');
      applyAppState(info);
      await loadTree();
    } catch (err) {
      fail(err);
      return;
    }

    if (info.runningJob) {
      state.busy = true;
      api('GET', `/api/jobs/${info.runningJob}`).then(({ job }) => followJob(job)).catch(fail);
    }

    await loadRemote();
  }

  init();
})();
