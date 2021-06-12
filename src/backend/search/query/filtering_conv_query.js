import FilteringStream from '../filtering_stream';

/**
 * Filter conversation messages.
 */
export default function FilteringConversationMessagesQuery(
    { ctx, db,  conversationId, filterRunner, rootGatherer }) {
  this._db = db;
  this.conversationId = conversationId;
  this._tocEventId = null;
  this._convEventId = null;
  this._drainEvents = null;
  this._boundTOCListener = null;
  this._boundConvListener = null;

  this._filteringStream = new FilteringStream({
    ctx, filterRunner, rootGatherer,
    isDeletion: (change) => {
      return (!change.postDate);
    },
    inputToGatherInto: (change) => {
      return {
        messageId: change.id,
        date: change.postDate
      };
    },
    mutateChangeToResembleAdd: (change) => {
      change.preDate = null;
      change.freshlyAdded = true;
    },
    mutateChangeToResembleDeletion: (change) => {
      change.item = null;
      change.postDate = null;
    },
    onFilteredUpdate: (change) => {
      this._boundTOCListener(change);
    }
  });

  this._bound_filteringTOCChange = this._filteringTOCChange.bind(this);
}
FilteringConversationMessagesQuery.prototype = {
  /**
   * Called by the TOC to initiate the initial fill and receive an initial big
   * glob of stuff.  For now we lie and pretend there are zero things and
   * instead act like everything is dynamic.  Correctness assumes the TOC will
   * promptly invoke bind() or we'll start firing notifications into the ether.
   * (This currently holds.)
   */
  async execute() {
    let idsWithDates;
    ({ idsWithDates,
       drainEvents: this._drainEvents,
       tocEventId: this._tocEventId,
       convEventId: this._convEventId } =
        await this._db.loadConversationMessageIdsAndListen(
          this.conversationId));

    for (let idWithDate of idsWithDates) {
      this._filteringStream.consider({
        id: idWithDate.id,
        preDate: null,
        postDate: idWithDate.date,
        item: null,
        freshlyAdded: true,
        matchInfo: null
      });
    }

    return [];
  },

  /**
   * Bind the listener for TOC changes, including immediately draining all
   * buffered events that were fired between the time the DB query was issued
   * and now.
   */
  bind(listenerObj, tocListenerMethod, convListenerMethod) {
    this._boundTOCListener = tocListenerMethod.bind(listenerObj);
    this._boundConvListener = convListenerMethod.bind(listenerObj);
    // TOC changes need to go into our filter
    this._db.on(this._tocEventId, this._bound_filteringTOCChange);
    // but the death of the conversation might as well be passed through,
    // for now.
    this._db.on(this._convEventId, this._boundConvListener);
    this._drainEvents(this._boundTOCListener);
    this._drainEvents = null;
  },

  /**
   * Events from the database about the Conversation we're filtering on.  We cram
   * these into the filtering stream.
   */
  _filteringTOCChange(change) {
    this._filteringStream.consider(change);
  },

  /**
   * Tear down everything.  Query's over.
   */
  destroy() {
    this._db.removeListener(this._tocEventId, this._bound_filteringTOCChange);
    this._db.removeListener(this._convEventId, this._boundConvListener);
    this._filteringStream.destroy();
  }
};
