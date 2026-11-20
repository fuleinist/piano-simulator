// An accessible searchable combobox for the song picker.
//
// The markup lives in index.html: a text input with role="combobox" that owns a
// role="listbox" popup. This module owns the behaviour. Matching and ranking
// live in src/songsearch.js, which has no DOM. Follows the WAI-ARIA 1.2
// combobox pattern: aria-expanded, aria-controls and aria-activedescendant
// track the popup, and the input keeps focus while the arrow keys move.
//
// Selecting the entry that is already selected still fires onSelect, so a piece
// can be reloaded from the start after a seek or a stop.

import { searchSongs } from './songsearch.js';

const optionId = (n) => `song-option-${n}`;

function appendHighlighted(el, text, ranges) {
  const value = String(text ?? '');
  let at = 0;
  for (const [start, end] of ranges || []) {
    if (start > at) el.append(value.slice(at, start));
    const mark = document.createElement('mark');
    mark.textContent = value.slice(start, end);
    el.append(mark);
    at = end;
  }
  if (at < value.length) el.append(value.slice(at));
}

export class SongPicker {
  /**
   * @param {{
   *   input: HTMLInputElement,
   *   listbox: HTMLElement,
   *   onSelect?: (item: object) => void,
   * }} options
   */
  constructor({ input, listbox, onSelect }) {
    this.input = input;
    this.listbox = listbox;
    this.onSelect = onSelect || (() => {});
    this.root = input.closest('.combobox') || input.parentElement;

    /** @type {{ label: string, items: object[] }[]} */
    this.groups = [];
    /** @type {Map<string, object>} */
    this.items = new Map();
    /** @type {{ id: string, el: HTMLElement }[]} */
    this.rows = [];
    this.selectedId = null;
    this.active = -1;
    this.opened = false;
    this._restore = '';

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', listbox.id);
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    listbox.hidden = true;

    input.addEventListener('focus', () => {
      // Select the current label, so typing replaces it instead of appending.
      if (!this.opened) input.select();
    });
    input.addEventListener('click', () => this.open());
    input.addEventListener('input', () => {
      if (!this.opened) this.open();
      this._render();
      this._setActive(0);
    });
    input.addEventListener('keydown', (e) => this._onKeyDown(e));

    // mousedown, not click: choosing an option must not blur the input first.
    listbox.addEventListener('mousedown', (e) => {
      const row = e.target.closest?.('.cb-option');
      if (!row) return;
      e.preventDefault();
      this._choose(row.dataset.id);
    });
    listbox.addEventListener('mousemove', (e) => {
      const row = e.target.closest?.('.cb-option');
      if (!row) return;
      const at = this.rows.findIndex((r) => r.el === row);
      if (at >= 0 && at !== this.active) this._setActive(at);
    });

    document.addEventListener('pointerdown', (e) => {
      if (this.opened && !this.root.contains(e.target)) this.close();
    });
  }

  /** @param {{ label: string, items: object[] }[]} groups */
  setGroups(groups) {
    this.groups = groups.filter((g) => g.items.length);
    this.items = new Map();
    for (const g of this.groups) for (const item of g.items) this.items.set(item.id, item);
    if (this.selectedId && !this.items.has(this.selectedId)) this.selectedId = null;
    this._refreshDisplay();
    if (this.opened) this._render();
  }

  /** Show `id` as the closed-state label. Does not fire onSelect. */
  setSelection(id) {
    this.selectedId = id;
    this._refreshDisplay();
    if (this.opened) this._render();
  }

  clearSelection() {
    this.selectedId = null;
    this._refreshDisplay();
    if (this.opened) this._render();
  }

  selectedItem() {
    return this.selectedId ? this.items.get(this.selectedId) || null : null;
  }

  label(item) {
    if (!item) return '';
    return item.composer ? `${item.title} — ${item.composer}` : String(item.title ?? '');
  }

  open() {
    if (this.opened) return;
    this.opened = true;
    this._restore = this.label(this.selectedItem());
    // The closed input shows the selection label. Clearing it on open means the
    // popup lists everything instead of filtering on the label text; closing
    // without a choice puts the label back.
    if (this.input.value === this._restore) this.input.value = '';
    this.input.setAttribute('aria-expanded', 'true');
    this.listbox.hidden = false;
    this._render();
    const at = this.rows.findIndex((r) => r.id === this.selectedId);
    this._setActive(at >= 0 ? at : 0);
  }

  close({ restore = true } = {}) {
    if (!this.opened) return;
    this.opened = false;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this.listbox.hidden = true;
    this.listbox.textContent = '';
    this.rows = [];
    this.active = -1;
    if (restore) this._refreshDisplay();
  }

  toggle() {
    this.opened ? this.close() : this.open();
  }

  _refreshDisplay() {
    this.input.value = this.label(this.selectedItem());
  }

  _render() {
    const query = this.input.value;
    const rows = [];
    this.listbox.textContent = '';

    for (const group of this.groups) {
      const matches = searchSongs(group.items, query);
      if (!matches.length) continue;

      const heading = document.createElement('div');
      heading.className = 'cb-group';
      heading.setAttribute('role', 'presentation');
      heading.textContent = group.label;
      this.listbox.append(heading);

      for (const item of matches) {
        const el = document.createElement('div');
        el.className = 'cb-option';
        el.id = optionId(rows.length);
        el.dataset.id = item.id;
        el.setAttribute('role', 'option');
        el.setAttribute('aria-selected', String(item.id === this.selectedId));

        const title = document.createElement('span');
        title.className = 'cb-opt-title';
        appendHighlighted(title, item.title, item.titleRanges);

        const composer = document.createElement('span');
        composer.className = 'cb-opt-composer';
        appendHighlighted(composer, item.composer, item.composerRanges);

        el.append(title, composer);
        this.listbox.append(el);
        rows.push({ id: item.id, el });
      }
    }

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'cb-empty';
      empty.setAttribute('role', 'presentation');
      empty.textContent = this.items.size ? 'No pieces match' : 'No pieces available';
      this.listbox.append(empty);
    }

    this.rows = rows;
    this.active = -1;
    this.input.removeAttribute('aria-activedescendant');
  }

  _setActive(at) {
    if (!this.rows.length) {
      this.active = -1;
      this.input.removeAttribute('aria-activedescendant');
      return;
    }
    const next = Math.min(this.rows.length - 1, Math.max(0, at));
    if (this.active >= 0 && this.rows[this.active]) {
      this.rows[this.active].el.classList.remove('active');
    }
    this.active = next;
    const row = this.rows[next];
    row.el.classList.add('active');
    this.input.setAttribute('aria-activedescendant', row.el.id);
    row.el.scrollIntoView({ block: 'nearest' });
  }

  _choose(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.selectedId = id;
    this._refreshDisplay();
    this.close({ restore: false });
    this.onSelect(item);
  }

  _onKeyDown(e) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!this.opened) this.open();
        else this._setActive(this.active + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!this.opened) this.open();
        else this._setActive(this.active - 1);
        break;
      case 'Home':
        if (!this.opened) return;
        e.preventDefault();
        this._setActive(0);
        break;
      case 'End':
        if (!this.opened) return;
        e.preventDefault();
        this._setActive(this.rows.length - 1);
        break;
      case 'Enter':
        if (!this.opened) return;
        e.preventDefault();
        if (this.active >= 0 && this.rows[this.active]) this._choose(this.rows[this.active].id);
        break;
      case 'Escape':
        if (!this.opened) return;
        e.preventDefault();
        this.close();
        break;
      case 'Tab':
        // Move focus on, but never leave a half-typed query in the field.
        if (this.opened) this.close();
        break;
      default:
        break;
    }
  }
}