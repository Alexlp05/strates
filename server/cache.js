// Cache LRU très simple pour les pochettes (images binaires) : on garde les
// plus récemment demandées et on oublie les plus anciennes au-delà de la limite.
// (Le cache des écoutes, lui, est l'archive : voir history.js.)

export class LruCache {
  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  get(key) {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
  }
}
