'use strict';
// Invoice client page. Talks only to the local server it was loaded from.

(() => {
  const TOKEN = document.querySelector('meta[name="session-token"]').content;

  const MONTHS = ['Ιανουάριος', 'Φεβρουάριος', 'Μάρτιος', 'Απρίλιος', 'Μάιος', 'Ιούνιος',
    'Ιούλιος', 'Αύγουστος', 'Σεπτέμβριος', 'Οκτώβριος', 'Νοέμβριος', 'Δεκέμβριος'];

  const $ = (id) => document.getElementById(id);

  const state = {
    tree: [],            // local archive, as sent by the server
    remote: null,        // { "<year>": ["<month folder>"] } from Drive, null while unknown
    remoteError: null,
    hasKey: true,
    model: { years: [], months: new Map(), files: [] },
    expanded: loadExpanded(),
    selection: null,     // { type: 'folder', key } | { type: 'file', path }
    job: null,
    busy: false,
  };

  let shownContent = null;   // what the content pane currently shows, to avoid reloading a PDF
  let loggedLines = 0;       // log lines of the current job already copied to the activity log

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

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
      throw new Error('The local server is not answering. Start it again with start.sh and reload this page.');
    }
    let data = null;
    try { data = await res.json(); } catch (err) { /* handled below */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
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
    const stamp = new Date(time || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

  function buildModel() {
    const years = new Map();
    const months = new Map();
    const files = [];

    const yearOf = (name) => {
      if (!years.has(name)) years.set(name, { name, months: [] });
      return years.get(name);
    };

    const addMonth = (parent, child) => {
      const key = monthKey(parent, child);
      if (months.has(key)) return months.get(key);
      const parsed = parseMonthFolder(parent, child);
      const month = {
        key, parent, child,
        label: parsed ? parsed.name : child,
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
      for (const month of year.months) files.push(...month.files);
    }

    state.model = { years: yearList, months, files };
  }

  // ---- tree --------------------------------------------------------------

  function toggle(key, open) {
    const next = open === undefined ? !state.expanded.has(key) : open;
    if (next) state.expanded.add(key); else state.expanded.delete(key);
    saveExpanded();
  }

  function renderTree() {
    const container = $('tree');
    const { years, files } = state.model;

    $('tree-status').textContent = files.length ? plural(files.length, 'file') : '';

    if (years.length === 0) {
      container.replaceChildren(h('div', { class: 'tree-empty', text: state.remote === null && !state.remoteError ? 'Loading…' : 'Nothing here yet.' }));
      return;
    }

    const isSelectedFolder = (month) => state.selection && state.selection.type === 'folder' && state.selection.key === month.key;
    const isSelectedFile = (file) => state.selection && state.selection.type === 'file' && state.selection.path === file.path;

    const fileRow = (file) => h('li', {},
      h('button', {
        type: 'button', class: 'tree-row file' + (isSelectedFile(file) ? ' selected' : ''), title: file.name,
        'data-path': file.path, onclick: () => selectFile(file.path),
      }, h('span', { class: 'file-icon', 'aria-hidden': 'true' }), h('span', { class: 'label', text: file.name })));

    const senderRow = (month, sender) => {
      if (sender.name === '') return sender.files.map(fileRow);
      const key = 's:' + sender.path;
      const open = state.expanded.has(key);
      return h('li', {},
        h('button', {
          type: 'button', class: 'tree-row sender', 'aria-expanded': String(open), title: sender.name,
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
          title: month.child,
          onclick: () => {
            if (selected && month.local) toggle(key); else toggle(key, true);
            selectFolder(month.key);
          },
        },
        h('span', { class: 'chevron' + (month.local ? '' : ' none'), 'aria-hidden': 'true' }),
        h('span', { class: 'label', text: month.label }),
        !month.local && h('span', { class: 'tag', text: 'Drive only' }),
        month.local && month.inDrive === false && h('span', { class: 'tag warn', text: 'Local only' }),
        month.local && h('span', { class: 'count', text: String(month.files.length) })),
        open && h('ul', {}, month.senders.map((sender) => senderRow(month, sender))));
    };

    const yearRow = (year) => {
      const key = 'y:' + year.name;
      const open = state.expanded.has(key);
      const count = year.months.reduce((sum, month) => sum + month.files.length, 0);
      return h('li', {},
        h('button', {
          type: 'button', class: 'tree-row year', 'aria-expanded': String(open),
          onclick: () => { toggle(key); renderTree(); },
        }, h('span', { class: 'chevron', 'aria-hidden': 'true' }), h('span', { class: 'label', text: year.name }), h('span', { class: 'count', text: String(count) })),
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

  function selectFile(path, { focusTree = false } = {}) {
    const file = state.model.files.find((f) => f.path === path);
    if (!file) return;
    const month = state.model.months.get(file.monthKey);
    toggle('y:' + month.parent, true);
    toggle('m:' + month.key, true);
    if (file.sender) toggle('s:' + `${month.path}/${file.sender}`, true);
    state.selection = { type: 'file', path };
    render();
    const row = [...$('tree').querySelectorAll('.tree-row.file')].find((el) => el.dataset.path === path);
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      if (focusTree) row.focus();
    }
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
      h('h2', { text: hasFiles ? 'Select a folder or a file' : hasFolders ? 'Nothing downloaded yet' : 'No invoices yet' }),
      h('p', {
        text: hasFiles ? 'Pick a month on the left to see its invoices. Click a file to open it here.'
          : hasFolders ? 'Your invoices are in Drive. Sync to save them on this computer.'
            : 'Fetch invoices from your mailbox to get started.',
      }),
      !hasFiles && h('button', {
        type: 'button', class: 'btn primary',
        text: hasFolders ? 'Sync from Drive' : 'Fetch invoices',
        onclick: () => (hasFolders ? startSync() : openFetchDialog()),
      }));
  }

  function neighbours(file) {
    const files = state.model.files;
    const index = files.findIndex((f) => f.path === file.path);
    return { index, total: files.length, previous: files[index - 1] || null, next: files[index + 1] || null };
  }

  function updateViewerNav(file) {
    const nav = neighbours(file);
    const prev = document.querySelector('[data-nav="prev"]');
    const next = document.querySelector('[data-nav="next"]');
    if (prev) prev.disabled = !nav.previous;
    if (next) next.disabled = !nav.next;
    const position = document.querySelector('[data-nav="position"]');
    if (position) position.textContent = `${nav.index + 1} / ${nav.total}`;
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
      body = h('pre', { text: 'Loading…' });
      fetch(fileUrl(file.path)).then((res) => res.text()).then((text) => { body.textContent = text; })
        .catch(() => { body.textContent = 'Could not load this file.'; });
    } else {
      body = h('div', { class: 'empty-state' },
        h('h2', { text: 'No preview for this file type' }),
        h('p', { text: 'You can save a copy and open it with another program.' }),
        h('a', { class: 'btn', href: fileUrl(file.path, true), download: file.name, text: 'Save a copy' }));
    }

    return h('div', { class: 'viewer' },
      h('div', { class: 'viewer-head' },
        h('div', { class: 'viewer-title' },
          h('strong', { text: file.name, title: file.name }),
          h('span', { text: [month.parent, month.label, file.sender].filter(Boolean).join('  ›  ') + `  ·  ${formatSize(file.size)}` })),
        h('span', { class: 'muted', 'data-nav': 'position', text: `${nav.index + 1} / ${nav.total}` }),
        h('button', { type: 'button', class: 'btn small', 'data-nav': 'prev', disabled: !nav.previous, title: 'Previous file', 'aria-label': 'Previous file', text: '‹', onclick: () => stepFile(-1) }),
        h('button', { type: 'button', class: 'btn small', 'data-nav': 'next', disabled: !nav.next, title: 'Next file', 'aria-label': 'Next file', text: '›', onclick: () => stepFile(1) }),
        h('a', { class: 'btn small', href: fileUrl(file.path, true), download: file.name, text: 'Save a copy' }),
        h('button', { type: 'button', class: 'btn small', title: 'Back to the folder', text: 'Close', onclick: () => selectFolder(file.monthKey) })),
      h('div', { class: 'viewer-body' }, body));
  }

  function stepFile(delta) {
    if (!state.selection || state.selection.type !== 'file') return;
    const files = state.model.files;
    const index = files.findIndex((f) => f.path === state.selection.path);
    const target = files[index + delta];
    if (target) selectFile(target.path);
  }

  function folderView(month) {
    const inDrive = month.inDrive !== false;
    const driveKnown = month.inDrive !== null;
    const folder = { parent_folder: month.parent, child_folder: month.child };
    const busy = state.busy;

    const meta = [];
    if (month.local) {
      meta.push(h('span', { text: `${plural(month.files.length, 'file')} · ${plural(month.senders.length, 'sender')} · ${formatSize(month.size)}` }));
    }
    if (driveKnown) {
      if (month.inDrive && month.local) meta.push(h('span', { class: 'tag ok', text: 'In Drive and on this computer' }));
      if (month.inDrive && !month.local) meta.push(h('span', { class: 'tag', text: 'In Drive, not downloaded' }));
      if (!month.inDrive) meta.push(h('span', { class: 'tag warn', text: 'Only on this computer' }));
    }

    const actions = h('div', { class: 'folder-actions' },
      inDrive && h('button', { type: 'button', class: 'btn', disabled: busy, text: 'Email this folder…', onclick: () => openMailDialog(month) }),
      inDrive && h('button', {
        type: 'button', class: month.local ? 'btn' : 'btn primary', disabled: busy,
        text: month.local ? 'Download missing files' : 'Download from Drive',
        onclick: () => startSync([folder]),
      }),
      inDrive && h('button', { type: 'button', class: 'btn', disabled: busy, text: 'Remove zip files', onclick: () => removeZips(month) }),
      inDrive && h('button', { type: 'button', class: 'btn danger', disabled: busy, text: 'Remove archive…', onclick: () => removeArchive(month) }),
      month.local && h('button', { type: 'button', class: 'btn danger', disabled: busy, text: 'Delete local copy…', onclick: () => deleteLocal(month) }));

    const groups = month.senders.map((sender) => h('div', { class: 'sender-group' },
      h('h3', { text: sender.name || 'Files' }),
      sender.files.map((file) => h('button', { type: 'button', class: 'file-row', onclick: () => selectFile(file.path) },
        h('span', { class: 'file-icon', 'aria-hidden': 'true' }),
        h('span', { class: 'name', text: file.name }),
        h('span', { class: 'size', text: formatSize(file.size) })))));

    return h('div', { class: 'folder-view' },
      h('div', { class: 'folder-head' }, h('h2', { text: month.child })),
      h('div', { class: 'folder-meta' }, meta),
      actions,
      groups.length ? groups : h('p', {
        class: 'muted',
        text: month.local ? 'This folder has no files.' : 'This folder is in Drive but not on this computer yet.',
      }));
  }

  // ---- render ------------------------------------------------------------

  function renderBanner() {
    const banner = $('banner');
    const action = $('banner-action');
    if (!state.hasKey) {
      $('banner-text').textContent = 'No key found. Put your API secret in a file named "key" next to start.sh, then press Try again.';
      action.hidden = false;
      banner.hidden = false;
    } else if (state.remoteError) {
      $('banner-text').textContent = `Could not read the folder list from Drive, so only the files on this computer are shown. ${state.remoteError}`;
      action.hidden = false;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  function render() {
    buildModel();
    renderBanner();
    renderTree();
    renderContent();
    $('btn-fetch').disabled = state.busy;
    $('btn-sync').disabled = state.busy;
  }

  // ---- loading -----------------------------------------------------------

  async function loadTree() {
    state.tree = (await api('GET', '/api/tree')).tree;
    render();
  }

  async function loadRemote() {
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
      state.hasKey = info.hasKey;
      await loadTree();
      await loadRemote();
      return info;
    } catch (err) {
      fail(err);
      return null;
    }
  }

  // ---- jobs --------------------------------------------------------------

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
      fail(err);
      setBusy(false);
    }
  }

  async function followJob(first) {
    let job = first;
    state.job = job;
    loggedLines = 0;
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
    finishJob(job);
  }

  function finishJob(job) {
    if (job.status === 'error') {
      toast(job.error, 'error');
      setActivity(job.error, 'error');
      return;
    }

    const result = job.result || {};
    let summary;
    if (job.type === 'fetch') {
      summary = `${plural(result.saved, 'new invoice')} found, ${plural(result.downloaded, 'file')} saved to this computer.`;
      if (result.saved === 0 && result.existing > 0 && result.downloaded === 0) summary = `No new invoices. All ${result.existing} are already saved.`;
      if (result.saved === 0 && result.existing === 0) summary = 'No invoices found for this period.';
      if (result.mailed) summary += ` ${plural(result.mailed, 'email')} sent to you.`;
    } else {
      summary = `${plural(result.downloaded, 'file')} downloaded, ${result.alreadyLocal} already on this computer.`;
    }

    const problems = (result.errors || []).length + (result.failed || []).length;
    if (problems) {
      summary += ` ${plural(problems, 'problem')}, see the log.`;
      $('activity-log').hidden = false;
      $('activity-toggle').textContent = 'Hide log';
      $('activity-toggle').setAttribute('aria-expanded', 'true');
    }

    toast(summary, problems ? 'error' : undefined);
    logLine(summary, problems ? 'error' : 'info');
    setActivity(summary, problems ? 'error' : 'done');

    // Show the most recent folder that was touched.
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
  function confirmDialog({ title, message, okLabel, danger, option }) {
    const dialog = $('dlg-confirm');
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-ok').textContent = okLabel || 'OK';
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
    const count = fetchChoice.months.size;
    $('fetch-submit').textContent = fetchMode() === 'months' && count > 1 ? `Fetch ${count} months` : 'Fetch';
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
        error.textContent = 'Choose at least one month.';
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
        error.textContent = 'Enter a whole number of days from 1 to 90.';
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

  function openMailDialog(month) {
    mailTarget = month;
    $('mail-folder').textContent = month.child;
    $('mail-error').hidden = true;
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
    let who = mailTo === 'USER' ? 'you' : 'your accountant';

    if (mailTo === 'OTHER') {
      mailTo = $('mail-other').value.trim();
      who = mailTo;
      if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(mailTo)) {
        $('mail-error').textContent = 'Enter a valid email address, like name@example.com.';
        $('mail-error').hidden = false;
        return;
      }
    }

    $('dlg-mail').close('ok');

    if (mailTo === 'ACCOUNTANT') {
      const answer = await confirmDialog({
        title: 'Send to your accountant?',
        message: `${month.child} will be emailed to your accountant as a zip file.`,
        okLabel: 'Send to accountant',
      });
      if (!answer.ok) return;
    }

    await runAction(`Emailing ${month.child} to ${who}…`, async () => {
      const { result } = await api('POST', '/api/mail', { parent_folder: month.parent, child_folder: month.child, mail_to: mailTo });
      return result.mode === 'drive_link'
        ? `The zip was too large to attach, so a Drive link was emailed to ${who}.`
        : `${month.child} was emailed to ${who} (${plural(result.files, 'file')}).`;
    });
  });

  // ---- folder actions ----------------------------------------------------

  /** Runs a short action with the buttons disabled and reports the outcome. */
  async function runAction(label, action, { refresh = false } = {}) {
    if (state.busy) return;
    setBusy(true);
    setActivity(label, 'running');
    logLine(label);
    try {
      const message = await action();
      state.busy = false;
      if (refresh) await reload(); else render();
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
      title: 'Remove zip files?',
      message: `The zip files in ${month.child} will be moved to the Drive trash. The invoices stay.`,
      okLabel: 'Remove zip files',
      danger: true,
    });
    if (!answer.ok) return;
    await runAction(`Removing zip files from ${month.child}…`, async () => {
      const { result } = await api('POST', '/api/remove-zips', { parent_folder: month.parent, child_folder: month.child });
      return result.removed ? `${plural(result.removed, 'zip file')} moved to the Drive trash.` : 'There were no zip files in this folder.';
    });
  }

  async function removeArchive(month) {
    const answer = await confirmDialog({
      title: 'Remove this archive from Drive?',
      message: `${month.child} and every invoice in it will be moved to the Drive trash. You can restore it from the trash for 30 days.`,
      okLabel: 'Remove archive',
      danger: true,
      option: month.local ? 'Also delete the copy on this computer' : null,
    });
    if (!answer.ok) return;
    await runAction(`Removing ${month.child} from Drive…`, async () => {
      const { result } = await api('POST', '/api/remove-archive', { parent_folder: month.parent, child_folder: month.child, delete_local: answer.checked });
      return result.localRemoved ? `${month.child} was removed from Drive and from this computer.` : `${month.child} was moved to the Drive trash.`;
    }, { refresh: true });
  }

  async function deleteLocal(month) {
    const onlyCopy = month.inDrive === false;
    const answer = await confirmDialog({
      title: 'Delete the local copy?',
      message: onlyCopy
        ? `${month.child} is no longer in Drive. Deleting it here removes the only copy.`
        : `${month.child} will be deleted from this computer. It stays in Drive and can be downloaded again.`,
      okLabel: 'Delete local copy',
      danger: true,
    });
    if (!answer.ok) return;
    await runAction(`Deleting the local copy of ${month.child}…`, async () => {
      await api('POST', '/api/delete-local', { parent_folder: month.parent, child_folder: month.child });
      return `The local copy of ${month.child} was deleted.`;
    }, { refresh: true });
  }

  // ---- wiring ------------------------------------------------------------

  $('btn-fetch').addEventListener('click', openFetchDialog);
  $('btn-sync').addEventListener('click', () => startSync());
  $('btn-refresh').addEventListener('click', async () => {
    setActivity('Reloading…', 'running');
    if (await reload()) setActivity('Ready', '');
  });
  $('banner-action').addEventListener('click', () => $('btn-refresh').click());

  $('activity-toggle').addEventListener('click', () => {
    const log = $('activity-log');
    log.hidden = !log.hidden;
    $('activity-toggle').textContent = log.hidden ? 'Show log' : 'Hide log';
    $('activity-toggle').setAttribute('aria-expanded', String(!log.hidden));
    log.scrollTop = log.scrollHeight;
  });

  async function init() {
    render();
    let info;
    try {
      info = await api('GET', '/api/state');
      state.hasKey = info.hasKey;
      await loadTree();
    } catch (err) {
      fail(err);
      return;
    }

    // Open the most recent year the first time.
    if (state.expanded.size === 0 && state.model.years.length) {
      toggle('y:' + state.model.years[0].name, true);
      render();
    }

    if (info.runningJob) {
      state.busy = true;
      render();
      api('GET', `/api/jobs/${info.runningJob}`).then(({ job }) => followJob(job)).catch(fail);
    }

    await loadRemote();
    if (state.expanded.size === 0 && state.model.years.length) {
      toggle('y:' + state.model.years[0].name, true);
      render();
    }
  }

  init();
})();
