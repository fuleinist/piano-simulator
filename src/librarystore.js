// The local MIDI library, stored in IndexedDB.
//
// localStorage is string-only and capped near 5 MB, so the bytes live in an
// object store keyed by the SHA-256 of the file. The record shape and every
// rule about it live in src/library.js; this module owns the database only.

import { usableRecords } from './library.js';

const DB_NAME = 'piano-sim';
const STORE = 'midi';
const DB_VERSION = 1;

/** True when this browser can store a library at all. */
export const libraryAvailable = () => typeof indexedDB !== 'undefined';

export class LibraryStore {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    if (!libraryAvailable()) throw new Error('This browser has no local database');
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        // The version field on each record handles later field additions; the
        // database version only guards the store's own shape.
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('The library did not open'));
      request.onblocked = () => reject(new Error('The library is open in another tab'));
    });
    return this.db;
  }

  /** Every readable record, newest-played first is left to the caller. */
  async list() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve(usableRecords(request.result));
      request.onerror = () => reject(request.error);
    });
  }

  async get(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Write one record. Resolves only when the transaction commits, so a quota
   * failure arrives as a rejected promise rather than a silent loss.
   */
  async put(record) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error || new Error('The library write failed'));
      tx.onabort = () => reject(tx.error || new Error('The library write was aborted'));
    });
  }

  async delete(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('The delete failed'));
      tx.onabort = () => reject(tx.error || new Error('The delete was aborted'));
    });
  }

  /** Mark a record as played now, so the picker can sort by recency. */
  async touch(id, now = Date.now()) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result;
        if (record) store.put({ ...record, lastPlayedAt: now });
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('The library write failed'));
      tx.onabort = () => reject(tx.error || new Error('The library write was aborted'));
    });
  }

  /** Ask the browser not to evict the library. False means best effort only. */
  async persist() {
    try {
      if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
    } catch {
      /* a refused request is not an error the player can act on */
    }
    return false;
  }

  /** Browser storage figures for the library dialog. */
  async estimate() {
    const out = { usage: 0, quota: 0, persisted: false };
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        out.usage = Number(est.usage) || 0;
        out.quota = Number(est.quota) || 0;
      }
      if (navigator.storage && navigator.storage.persisted) {
        out.persisted = await navigator.storage.persisted();
      }
    } catch {
      /* the dialog falls back to the library byte total */
    }
    return out;
  }
}