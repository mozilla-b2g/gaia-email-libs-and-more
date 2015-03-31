define(function(require) {

let a64 = require('../a64');

let utils = require('../utils');
let bsearchMaybeExists = utils.bsearchMaybeExists;
let bsearchForInsert = utils.bsearchForInsert;

let RefedResource = require('../refed_resource');
let cmpUI64 = a64.cmpUI64;

let evt = require('evt');

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
  evt.Emitter.call(this);
  this._db = db;
  this.folderId = folderId;
  this._eventId = '';

  this._bound_onTOCChange = this.onTOCChange.bind(this);

  this.__deactivate();
}
FolderConversationsTOC.prototype = evt.mix(RefedResource.mix({
  __activate: function*() {
    let { idsWithDates, drainEvents, eventId } =
      yield this._db.loadFolderConversationIdsAndListen(this.folderId);

    this.idsWithDates = idsWithDates;
    this._eventId = eventId;
    drainEvents(this._bound_onChange);
    this._db.on(eventId, this._bound_onTOCChange);
  },

  __deactivate: function() {
    this.idsWithDates = [];
    this._db.removeListener(this._eventId, this._bound_onChange);
  },

  get length() {
    return this.idsWithDates.length;
  },

  /**
   * Handle a change from the database.
   *
   * @param {Object} change
   * @param {ConvId} id
   * @param {ConvInfo} item
   * @param {DateTS} removeDate
   * @param {DateTS} addDate
   */
  onTOCChange: function(change) {
    let metadataOnly = change.removeDate === change.addDate;

    if (!metadataOnly) {
      let oldIndex = -1;
      if (change.removeDate) {
        let oldKey = { date: change.removeDate, id: change.id };
        oldIndex = bsearchMaybeExists(this.idsWithDates, oldKey,
                                      folderConversationComparator);
        // NB: if we computed the newIndex before splicing out, we could avoid
        // potentially redundant operations, but it's not worth the complexity
        // at this point.
        this.idsWithDates.splice(oldIndex, 1);
      }
      let newIndex = -1;
      if (change.addDate) {
        let newKey = { date: change.addDate, id: change.id };
        newIndex = bsearchForInsert(this.idsWithDates, newKey,
                                    folderConversationComparator);
        this.idsWithDates.splice(newIndex, 0, newKey);
      }

      // If we did end up keeping the conversation in place, then it was just
      // a metadata change as far as our consumers know/care.
      if (oldIndex === newIndex) {
        metadataOnly = true;
      }
    }

    // We could expose more data, but WindowedListProxy doesn't need it, so
    // don't expose it yet.  If we end up with a fancier consumer (maybe a neat
    // debug visualization?), it could make sense to expose the indices being
    // impacted.
    this.emit('change', id, metadataOnly);
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

  getOrderingKeyForIndex: function(index) {
    return this.idsWithDates[index];
  },

  findIndexForOrderingKey: function(key) {
    let index = bsearchForInsert(this.idsWithDates, key,
                                 folderConversationComparator);
    return index;
  },

  getDataForSliceRange: function(beginInclusive, endExclusive, alreadyKnown) {
    // Things we were able to directly extract from the cache
    let haveData = new Map();
    // Things we need to request from the database.  (Although MailDB.read will
    // immediately populate the things we need, WindowedListProxy's current
    // wire protocol calls for omitting things we don't have the state for yet.
    // And it's arguably nice to avoid involving going async here with flushes
    // and all that if we can avoid it.
    let needData = new Map();
    // The new known set which is the stuff from alreadyKnown we reused plus the
    //
    let newKnownSet = new Set();

    let idsWithDates = this.idsWithDates;
    let convCache = this._db.convCache;
    let ids = [];
    for (let i = beginInclusive; i < endExclusive; i++) {
      let id = idsWithDates[i].id;
      ids.push(id);
      if (alreadyKnown) {
        continue;
      }
      if (convCache.has(id)) {
        haveData.set(id, convCache.get(id));
      } else {
        needData.set(id, null);
      }
    }

    let readPromise = null;
    if (needData.size) {
      readPromise = this._db.read({
        conv: needData
      })
    } else {
      needData = null;
    }

    return {
      ids: ids,
      state: haveData,
      pendingReads: needData,
      readPromise: readPromise
    };
  }
}));

return FolderConversationsTOC;
});
