/**
 * Query that directly exposes the entirety of a conversation index.
 * Basically just normalizes the pre-query implementation so we don't need
 * multiple TOC variants, etc.
 */
export default function DirectConversationMessagesQuery({ db, conversationId }) {
  this._db = db;
  this.conversationId = conversationId;
  this._tocEventId = null;
  this._convEventId = null;
  this._drainEvents = null;
  this._boundTOCListener = null;
  this._boundConvListener = null;
}
DirectConversationMessagesQuery.prototype = {
  /**
   * Initiate the initial query fill, returning a Promise that will be resolved
   * with the initial set.  Once the set has been processed, the `bind` method
   * should be invoked to allow buffered events to be replayed and to start
   * new events triggering the onTOCChange method.
   */
  async execute() {
    let idsWithDates;
    ({ idsWithDates, drainEvents: this._drainEvents,
         tocEventId: this._tocEventId, convEventId: this._convEventId } =
      await this._db.loadConversationMessageIdsAndListen(this.conversationId));

    return idsWithDates;
  },

  /**
   * Bind the listener for TOC changes, including immediately draining all
   * buffered events that were fired between the time the DB query was issued
   * and now.
   */
  bind(listenerObj, tocListenerMethod, convListenerMethod) {
    this._boundTOCListener = tocListenerMethod.bind(listenerObj);
    this._boundConvListener = convListenerMethod.bind(listenerObj);
    this._db.on(this._tocEventId, this._boundTOCListener);
    this._db.on(this._convEventId, this._boundConvListener);
    this._drainEvents(this._boundTOCListener);
    this._drainEvents = null;
  },

  /**
   * Tear down everything.  Query's over.
   */
  destroy() {
    this._db.removeListener(this._tocEventId, this._boundTOCListener);
    this._db.removeListener(this._convEventId, this._boundConvListener);
  }
};
