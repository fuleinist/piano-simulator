// The My MIDI files dialog.
//
// The picker lists stored files, but a picker row cannot carry Rename and
// Delete without breaking the listbox semantics. This dialog owns those
// actions instead: it lists every stored file with its size, note count and
// last played date, and offers Load, Rename and Delete per row.
//
// The dialog element gives focus trapping and Escape for free. Delete needs a
// second click within four seconds, which avoids a nested confirm dialog.

import { formatBytes, summarise, totalBytes, WARN_BYTES } from './library.js';

const dateLabel = (ms) => {
  if (!ms) return 'never played';
  try {
    return `played ${new Date(ms).toLocaleDateString()}`;
  } catch {
    return 'played';
  }
};

export class LibraryPanel {
  /**
   * @param {{
   *   dialog: HTMLDialogElement,
   *   list: HTMLElement,
   *   summary: HTMLElement,
   *   storage: HTMLElement,
   *   empty: HTMLElement,
   *   onLoad: (key: string) => void,
   *   onRename: (key: string, changes: { title: string, composer: string }) => void,
   *   onDelete: (key: string) => void,
   * }} options
   */
  constructor({ dialog, list, summary, storage, empty, onLoad, onRename, onDelete }) {
    this.dialog = dialog;
    this.list = list;
    this.summary = summary;
    this.storage = storage;
    this.empty = empty;
    this.onLoad = onLoad;
    this.onRename = onRename;
    this.onDelete = onDelete;
    this.records = [];
    this._pendingDelete = null;
    this._deleteTimer = 0;

    list.addEventListener('click', (e) => this._onClick(e));
    list.addEventListener('keydown', (e) => this._onListKey(e));
  }

  get isOpen() {
    return this.dialog.open;
  }

  open(records, storage) {
    this.setRecords(records, storage);
    if (!this.dialog.open) this.dialog.showModal();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  /** @param {object[]} records stored records, already sorted */
  setRecords(records, storage = null) {
    this.records = records || [];
    this._storage = storage;
    this._render();
  }

  _render() {
    this.list.textContent = '';
    this._pendingDelete = null;
    clearTimeout(this._deleteTimer);

    this.summary.textContent = summarise(this.records);
    this.empty.hidden = this.records.length > 0;
    this.list.hidden = this.records.length === 0;

    for (const record of this.records) this.list.append(this._row(record));

    const lines = [];
    const total = totalBytes(this.records);
    if (total > WARN_BYTES) {
      lines.push(`Your library holds ${formatBytes(total)}. Browser storage can fill up, so delete what you no longer play.`);
    }
    if (this._storage) {
      const { usage, quota, persisted } = this._storage;
      if (usage) lines.push(`Browser storage: ${formatBytes(usage)} used${quota ? ` of ${formatBytes(quota)}` : ''}.`);
      lines.push(persisted
        ? 'The browser is holding this library across restarts.'
        : 'The browser may clear this library when storage runs low, or when a private window closes.');
    }
    this.storage.textContent = lines.join(' ');
  }

  _row(record) {
    const row = document.createElement('li');
    row.className = 'lib-row';
    row.dataset.key = record.id;

    const main = document.createElement('div');
    main.className = 'lib-main';

    const title = document.createElement('span');
    title.className = 'lib-title';
    title.textContent = record.title || 'Untitled MIDI';

    const composer = document.createElement('span');
    composer.className = 'lib-composer';
    composer.textContent = record.composer || '';
    composer.hidden = !record.composer;

    const meta = document.createElement('span');
    meta.className = 'lib-meta';
    const bits = [formatBytes(record.size)];
    if (record.noteCount) bits.push(`${record.noteCount} notes`);
    bits.push(dateLabel(record.lastPlayedAt));
    meta.textContent = bits.join(' · ');

    main.append(title, composer, meta);

    const actions = document.createElement('div');
    actions.className = 'lib-actions';
    for (const [act, label] of [['load', 'Load'], ['rename', 'Rename'], ['delete', 'Delete']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = act === 'delete' ? 'btn small danger' : 'btn small';
      button.dataset.act = act;
      button.textContent = label;
      actions.append(button);
    }

    row.append(main, actions);
    return row;
  }

  _onClick(e) {
    const button = e.target.closest('button[data-act]');
    if (!button) return;
    const row = button.closest('.lib-row');
    const key = row?.dataset.key;
    if (!key) return;

    switch (button.dataset.act) {
      case 'load':
        this.close();
        this.onLoad(key);
        break;
      case 'rename':
        this._startRename(row);
        break;
      case 'delete':
        this._confirmDelete(button, key);
        break;
      default:
        break;
    }
  }

  _confirmDelete(button, key) {
    if (this._pendingDelete !== key) {
      this._clearDeletePrompt();
      this._pendingDelete = key;
      button.textContent = 'Delete?';
      button.classList.add('armed');
      // A stray click must not delete a file, so the prompt lapses.
      this._deleteTimer = setTimeout(() => this._clearDeletePrompt(), 4000);
      return;
    }
    this._clearDeletePrompt();
    this.onDelete(key);
  }

  _clearDeletePrompt() {
    clearTimeout(this._deleteTimer);
    this._deleteTimer = 0;
    this._pendingDelete = null;
    for (const button of this.list.querySelectorAll('button[data-act="delete"].armed')) {
      button.classList.remove('armed');
      button.textContent = 'Delete';
    }
  }

  _startRename(row) {
    if (row.classList.contains('renaming')) return;
    const key = row.dataset.key;
    const record = this.records.find((r) => r.id === key);
    if (!record) return;

    row.classList.add('renaming');
    const form = document.createElement('form');
    form.className = 'lib-rename';
    form.method = 'dialog';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = record.title || '';
    titleInput.setAttribute('aria-label', 'Title');
    titleInput.required = true;

    const composerInput = document.createElement('input');
    composerInput.type = 'text';
    composerInput.value = record.composer || '';
    composerInput.setAttribute('aria-label', 'Composer');

    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'btn small';
    save.textContent = 'Save';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn small';
    cancel.textContent = 'Cancel';

    form.append(titleInput, composerInput, save, cancel);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = titleInput.value.trim();
      if (!title) { titleInput.focus(); return; }
      this.onRename(key, { title, composer: composerInput.value.trim() });
    });
    cancel.addEventListener('click', () => this._render());

    row.querySelector('.lib-main').replaceWith(form);
    row.querySelector('.lib-actions').hidden = true;
    titleInput.focus();
    titleInput.select();
  }

  _onListKey(e) {
    // A row being renamed traps Escape itself; anything else falls through to
    // the dialog, which closes on Escape.
    if (e.key === 'Escape' && e.target.closest('.lib-row.renaming')) {
      e.preventDefault();
      e.stopPropagation();
      this._render();
    }
  }
}