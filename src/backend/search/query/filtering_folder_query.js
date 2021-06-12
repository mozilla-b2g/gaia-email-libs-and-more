import FilteringStream from '../filtering_stream';

/**
 * Query that filters a folder conversations index.
 */
export default function FilteringFolderQuery({ ctx, db, folderId, filterRunner,
                                rootGatherer, preDerivers, postDerivers }) {
  this._db = db;
  this.folderId = folderId;
  this._eventId = null;
  this._drainEvents = null;
  this._boundListener = null;

  this._filteringStream = new FilteringStream({
    ctx, filterRunner, rootGatherer,
    preDerivers, postDerivers,
    isDeletion: (change) => {
      return (!change.addDate);
    },
    inputToGatherInto: (change) => {
      return {
        convId: change.id
      };
    },
    mutateChangeToResembleAdd: (change) => {
      change.removeDate = null;
    },
    mutateChangeToResembleDeletion: (change) => {
      change.item = null;
      change.addDate = null;
      change.height = 0;
    },
    onFilteredUpdate: (change) => {
      this._boundListener(change);
    }
  });

  this._bound_filteringTOCChange = this._filteringTOCChange.bind(this);
}
FilteringFolderQuery.prototype = {
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
      eventId: this._eventId } =
        await this._db.loadFolderConversationIdsAndListen(this.folderId));

    for (let idWithDate of idsWithDates) {
      this._filteringStream.consider({
        id: idWithDate.id,
        item: null,
        removeDate: null,
        addDate: idWithDate.date,
        height: idWithDate.height,
        oldHeight: 0,
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
  bind(listenerObj, listenerMethod) {
    this._boundListener = listenerMethod.bind(listenerObj);
    this._db.on(this._eventId, this._bound_filteringTOCChange);
    this._drainEvents(this._bound_filteringTOCChange);
    this._drainEvents = null;
  },

  /**
   * Events from the database about the folder we're filtering on.  We cram
   * these into the filtering stream.
   */
  _filteringTOCChange(change) {
    this._filteringStream.consider(change);
  },

  /**
   * Tear down everything.  Query's over.
   */
  destroy() {
    this._db.removeListener(this._eventId, this._bound_filteringTOCChange);
    this._filteringStream.destroy();
  }
};
