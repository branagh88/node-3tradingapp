// storage.js
// Small localStorage wrapper used by the application.

const PREFIX = 'market-intelligence:';
const VERSION = 1;

function key(name) { return `${PREFIX}${name}`; }

function read(name, fallback = null) {
  try {
    const raw = localStorage.getItem(key(name));
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[Storage] Read failed:', name, err);
    return fallback;
  }
}

function write(name, value) {
  try {
    localStorage.setItem(key(name), JSON.stringify(value));
    return true;
  } catch (err) {
    console.error('[Storage] Write failed:', name, err);
    return false;
  }
}

function remove(name) {
  try { localStorage.removeItem(key(name)); return true; }
  catch { return false; }
}

function collection(name, max) {
  const collectionKey = `collection:${name}`;
  const limit = Number(max);
  const bounded = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;

  function getAll() {
    const value = read(collectionKey, []);
    return Array.isArray(value) ? value : [];
  }

  function saveAll(items) { write(collectionKey, items); }

  // Move a known item to the end (most-recently-used) for bounded collections.
  function touch(items, item) {
    const idx = items.indexOf(item);
    if (idx >= 0 && idx !== items.length - 1) {
      items.splice(idx, 1);
      items.push(item);
    }
    return items;
  }

  return {
    getAll,
    // Smoke contract / generic read of the whole collection.
    all() { return getAll(); },
    get(id) {
      const items = getAll();
      const found = items.find(item => item && item.id === id);
      if (!found) return undefined;
      if (bounded) {
        touch(items, found);
        saveAll(items);
      }
      return found;
    },
    put(item) {
      if (!item || item.id == null) return null;
      const items = getAll();
      const index = items.findIndex(existing => existing.id === item.id);
      if (index >= 0) {
        items[index] = item;
        if (bounded) touch(items, item);
      } else {
        items.push(item);
      }
      if (bounded && items.length > bounded) items.splice(0, items.length - bounded);
      saveAll(items);
      return item;
    },
    add(item) { return this.put(item); },
    set(item) { return this.put(item); },
    remove(id) {
      const items = getAll();
      const filtered = items.filter(item => item && item.id !== id);
      saveAll(filtered);
      return filtered.length !== items.length;
    },
    clear() { saveAll([]); },
    count() { return getAll().length; },
  };
}

export const storage = {
  version: VERSION,
  get(name, fallback = null) { return read(name, fallback); },
  set(name, value) { return write(name, value); },
  remove,
  clear(name) { return remove(name); },
  collection,
  migrate() {
    try {
      const current = read('storageVersion', 0);
      if (current < VERSION) write('storageVersion', VERSION);
    } catch (err) {
      console.warn('[Storage] Migration failed:', err);
    }
  },
};

export default storage;
