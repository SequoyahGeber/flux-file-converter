// Keep each explicit Apple security scope balanced, including replacement and quit.
class FileScopes {
  constructor(startAccess) {
    this.startAccess = startAccess;
    this.stops = new Map();
  }
  acquire(key, bookmark) {
    if (!bookmark) return;
    const stop = this.startAccess(bookmark);
    if (typeof stop !== 'function')
      throw new Error('Choose this file or folder again to allow access.');
    this.release(key);
    this.stops.set(key, stop);
  }
  release(key) {
    const stop = this.stops.get(key);
    this.stops.delete(key);
    stop?.();
  }
  releaseAll() {
    for (const key of this.stops.keys()) this.release(key);
  }
}
module.exports = { FileScopes };
