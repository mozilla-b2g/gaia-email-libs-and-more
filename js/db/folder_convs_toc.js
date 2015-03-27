define(function(require) {

let a64 = require('../a64');

let utils = require('../utils');
let bsearchMaybeExists = utils.bsearchMaybeExists;
let bsearchForInsert = utils.bsearchForInsert;

let RefedResource = require('../refed_resource');
let cmpUI64 = a64.cmpUI64;

function folderConversationComparator(a, b) {
  let dateDelta = b.date - a.date;
  if (dateDelta) {
    return dateDelta
  }
  // So for the id's, we just want consistent.  We don't actually care about the
  // strict numerical ordering of the underlying conversation identifier (sans
  // account id), so we can just do lexical string ordering for this.
  let aId = a.id;
  let bId = b.id;
  if (bId > aId) {
    return 1;
  } else if (aId > bId) {
    return -1;
  } else {
    return 0;
  }
}

/**
 * Backs view-slices listing the conversations in a folder.
 *
 * The current approach is that at activation time we load the entirety of the
 * ordered conversations for a folder, but just their conversation id and most
 * recent message, which constitute our ordering/identifying composite key.
 * This is a small enough amount of information that it is not unreasonable to
 * have it in memory given that we only list synchronized messages and that our
 * correlated resource constraints limit how much we sync.  In a fancy future
 * maybe we would not keep everything in memory.  However this strategy also
 * potentially could be beneficial with supporting full-sorting.  In any event,
 * we assume this means that once activated that we can synchronously tell you
 * everything you want to know about the ordering of the list.
 *
 * Our composite key is { date, id }, ordered thusly.  From a seek/persistence
 * perspective, if a conversation gets updated, it is no longer the same and
 * we instead treat the position where the { date, id } would be inserted now.
 * However, for
 */
function FolderConversationsTOC(db, folderId) {
  RefedResource.call(this);
  this._db = db;
  this.folderId = folderId;
  this._eventId = '';

  this._bound_onChange = this.onChange.bind(this);

  this.__deactivate();
}
FolderConversationsTOC.prototype = RefedResource.mix({
  __activate: function*() {
    let { idsWithDates, drainEvents, eventId } =
      yield this._db.loadFolderConversationIdsAndListen(this.folderId);

    this.idsWithDates = idsWithDates;
    this._eventId = eventId;
    drainEvents(this._bound_onChange);
    this._db.on(eventId, this._bound_onChange);
  },

  __deactivate: function() {
    this.idsWithDates = [];
    this._db.removeListener(this._eventId, this._bound_onChange);
  },

  /**
   * Handle a change from the database.
   */
  onChange: function(change) {

  },

  /**
   * Return an array of the conversation id's occupying the given indices.
   */
  sliceIds: function(begin, end) {
    let ids = new Array();
    let idsWithDates = this.idsWithDates;
    for (let i = begin; i < end; i++) {
      ids.push(idsWithDates[i].id);
    }
    return ids;
  },

  getDataForId: function(id) {

  }
});

return FolderConversationsTOC;
});
