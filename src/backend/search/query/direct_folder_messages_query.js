
/**
 * Query that directly exposes the entirety of a conversation folder index.
 * Basically just normalizes the pre-query implementation so we don't need
 * multiple TOC variants, etc.
 */
 export default function DirectFolderMessagesQuery({ db, folderId }) {
  this._db = db;
  this.folderId = folderId;
  this._eventId = null;
  this._drainEvents = null;
  this._boundListener = null;
}
DirectFolderMessagesQuery.prototype = {
  /**
   * Initiate the initial query fill, returning a Promise that will be resolved
   * with the initial set.  Once the set has been processed, the `bind` method
   * should be invoked to allow buffered events to be replayed and to start
   * new events triggering the onTOCChange method.
   */
  async execute() {
    let idsWithDates;
    ({ idsWithDates,
      drainEvents: this._drainEvents,
      eventId: this._eventId } =
        await this._db.loadFolderMessageIdsAndListen(this.folderId));

    return idsWithDates;
  },

  /**
   * Bind the listener for TOC changes, including immediately draining all
   * buffered events that were fired between the time the DB query was issued
   * and now.
   */
  bind(listenerObj, listenerMethod) {
    let boundListener = this._boundListener = listenerMethod.bind(listenerObj);
    this._db.on(this._eventId, boundListener);
    this._drainEvents(boundListener);
    this._drainEvents = null;
  },

  /**
   * Tear down everything.  Query's over.
   */
  destroy() {
    this._db.removeListener(this._eventId, this._boundListener);
  }
};
