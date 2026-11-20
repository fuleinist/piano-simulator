// The Find music dialog.
//
// Shows results from the remote catalogue with the licence and the source next
// to each one. Loading and saving are callbacks, so this module owns the panel
// and the network module owns the requests.
//
// The query is debounced, and a new query aborts the old one, so a fast typist
// never starts a queue of requests.

import { searchAll } from './midisources.js';
import { formatBytes } from './library.js';

const DEBOUNCE_MS = 300;

export class SearchPanel {
  /**
   * @param {{
   *   dialog: HTMLDialogElement,
   *   form: HTMLFormElement,
   *   input: HTMLInputElement,
   *   status: HTMLElement,
   *   results: HTMLElement,
   *   providers: object[],
   *   onLoad: (result: object) => Promise<void>,
   *   onSave: (result: object) => Promise<void>,
   * }} options
   */
  constructor({ dialog, form, input, status, results, providers, onLoad, onSave }) {
    this.dialog = dialog;
    this.form = form;
    this.input = input;
    this.status = status;
    this.list = results;
    this.providers = providers;
    this.onLoad = onLoad;
    this.onSave = onSave;
    this.results = [];
    this.abort = null;
    this.timer = 0;
    this.busy = false;

    form.addEventListener('submit', (e) => { e.preventDefault(); this.run(this.input.value, { now: true }); });
    input.addEventListener('input', () => this.run(this.input.value));
    this.list.addEventListener('click', (e) => this._onClick(e));
    dialog.addEventListener('close', () => {
      clearTimeout(this.timer);
      this.abort?.abort();
    });
  }

  open(query = '') {
    if (query) this.input.value = query;
    if (!this.dialog.open) this.dialog.showModal();
    this.input.focus();
    this.input.select();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  /** Debounced search. An empty query clears the list. */
  run(query, { now = false } = {}) {
    clearTimeout(this.timer);
    const trimmed = String(query ?? '').trim();
    if (!trimmed) {
      this.abort?.abort();
      this.results = [];
      this._render();
      this._setStatus('Results come from the Internet Archive. Check the licence before you publish a recording.');
      return;
    }
    this.timer = setTimeout(() => this._search(trimmed), now ? 0 : DEBOUNCE_MS);
  }

  async _search(query) {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    this._setStatus(`Searching for “${query}”…`);
    this.list.hidden = true;

    try {
      const { results, errors } = await searchAll(
        this.providers.map((provider) => ({ ...provider, search: (q, opts) => provider.search(q, { ...opts, signal: controller.signal }) })),
        query,
      );
      if (controller.signal.aborted) return;
      this.results = results;
      this._render(query, errors);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.results = [];
      this._render(query, [{ source: 'Search', message: String(error?.message || error) }]);
    }
  }

  _setStatus(text) {
    this.status.textContent = text;
  }

  _render(query = '', errors = []) {
    this.list.textContent = '';
    this.list.hidden = this.results.length === 0;

    for (const result of this.results) this.list.append(this._row(result));

    if (this.results.length) {
      this._setStatus(`${this.results.length} ${this.results.length === 1 ? 'result' : 'results'} for “${query}”. Check the licence before you publish a recording.`);
      return;
    }
    if (errors.length) {
      this._setStatus(`The search failed: ${errors.map((e) => e.message).join('. ')}. Playback of your own files still works.`);
      return;
    }
    if (query) this._setStatus(`No pieces match “${query}”. Try a composer or a shorter title.`);
  }

  _row(result) {
    const row = document.createElement('li');
    row.className = 'lib-row';
    row.dataset.id = result.id;

    const main = document.createElement('div');
    main.className = 'lib-main';

    const title = document.createElement('span');
    title.className = 'lib-title';
    title.textContent = result.title;

    const composer = document.createElement('span');
    composer.className = 'lib-composer';
    composer.textContent = result.composer || '';
    composer.hidden = !result.composer;

    const meta = document.createElement('span');
    meta.className = 'lib-meta';
    const licence = document.createElement('a');
    licence.textContent = result.license;
    if (result.licenseUrl) {
      licence.href = result.licenseUrl;
      licence.target = '_blank';
      licence.rel = 'noopener noreferrer';
    }
    const bits = [result.source];
    if (result.size) bits.push(formatBytes(result.size));
    meta.append(`${bits.join(' · ')} · `, licence);

    main.append(title, composer, meta);

    const actions = document.createElement('div');
    actions.className = 'lib-actions';
    for (const [act, label] of [['load', 'Load'], ['save', 'Save']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn small';
      button.dataset.act = act;
      button.textContent = label;
      actions.append(button);
    }
    const source = document.createElement('a');
    source.className = 'btn small';
    source.href = result.sourceUrl;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = 'Item';
    actions.append(source);

    row.append(main, actions);
    return row;
  }

  async _onClick(e) {
    const button = e.target.closest('button[data-act]');
    if (!button || this.busy) return;
    const row = button.closest('.lib-row');
    const result = this.results.find((r) => r.id === row?.dataset.id);
    if (!result) return;

    const buttons = [...row.querySelectorAll('button')];
    this.busy = true;
    buttons.forEach((b) => { b.disabled = true; });
    const original = button.textContent;
    button.textContent = button.dataset.act === 'save' ? 'Saving…' : 'Loading…';

    try {
      if (button.dataset.act === 'save') await this.onSave(result);
      else await this.onLoad(result);
      button.textContent = button.dataset.act === 'save' ? 'Saved' : 'Loaded';
    } catch (error) {
      this._setStatus(`That file did not load: ${error?.message || error}.`);
      button.textContent = original;
    } finally {
      this.busy = false;
      buttons.forEach((b) => { b.disabled = false; });
    }
  }
}