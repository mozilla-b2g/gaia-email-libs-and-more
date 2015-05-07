define(function(require) {
'use strict';

let co = require('co');
let logic = require('logic');

let a64 = require('../a64');
let compareMsgIds = a64.cmpUI64;

let util = require('../util');
let bsearchMaybeExists = util.bsearchMaybeExists;
let bsearchForInsert = util.bsearchForInsert;

let RefedResource = require('../refed_resource');

let evt = require('evt');

let { conversationMessageComparator } = require('./comparators');

/**
 * The Conversation Table-of-Contents is in charge of backing view slices
 * listing the messages in a specific conversation.
 *
 * This primarily entails tracking how many messages there are in the
 * conversation and maintaining an ordering of all those messages so that if
 * a request comes in for messages by position that we can issue the database
 * requests for them.   There are a lot of similarities between this
 * implementation and FolderConversationsTOC, but significantly our items cannot
 * change their ordering key.  A message's date at the time of creation is fixed
 * and cannot change.  Anything that would result in that behaviour will be
 * implemented as a removal followed by an addition.
 *
 * This is a reference-counted object that is created on-demand as soon as a
 * view slice is requested for a given conversation and destroyed once no more
 * view slices care about.
 */
function ConversationTOC(db, convId) {
  RefedResource.call(this);
  evt.Emitter.call(this);

  logic.defineScope(this, 'ConversationTOC');

  this._db = db;
  this.convId = convId;
  // id for toc-style changes to the ordered set of messages in the conversation
  this._tocEventId = '';
  // id for the conversation summary; used to detect the deletion of the
  // conversation
  this._convEventId = '';

  this._bound_onTOCChange = this.onTOCChange.bind(this);
  this._bound_onConvChange = this.onConvChange.bind(this);

  this.__deactivate();
}
ConversationTOC.prototype = evt.mix(RefedResource.mix({
  type: 'ConversationTOC',

  __activate: co.wrap(function*() {
    // NB: Although our signature is for this to just provide us with the id's,
    // this actually has the byproduct of loading the header records and placing
    // them in the cache because we can't currently just get the keys.
    let { idsWithDates, drainEvents, tocEventId, convEventId } =
      yield this._db.loadConversationMessageIdsAndListen(this.folderId);

    this.idsWithDates = idsWithDates;
    this._tocEventId = tocEventId;
    this._convEventId = convEventId;
    drainEvents(this._bound_onTOCChange);
    this._db.on(tocEventId, this._bound_onTOCChange);
    this._db.on(convEventId, this._bound_onConvChange);
  }),

  __deactivate: function() {
    this.idsWithDates = [];
    this._db.removeListener(this._tocEventId, this._bound_onTOCChange);
  },

  get length() {
    return this.idsWithDates.length;
  },

  /**
   * Handle the addition or removal of a message from the TOC.
   *
   * @param {MessageId} messageId
   * @param {DateTS} date
   * @param {HeaderInfo} headerInfo
   */
  onTOCChange: function(messageId, date, headerInfo) {


    let metadataOnly = change.removeDate === change.addDate;

    if (!metadataOnly) {
      let oldIndex = -1;
      if (change.removeDate) {
        let oldKey = { date: change.removeDate, id: change.id };
        oldIndex = bsearchMaybeExists(this.idsWithDates, oldKey,
                                      conversationMessageComparator);
        // NB: if we computed the newIndex before splicing out, we could avoid
        // potentially redundant operations, but it's not worth the complexity
        // at this point.
        this.idsWithDates.splice(oldIndex, 1);
      }
      let newIndex = -1;
      if (change.addDate) {
        let newKey = { date: change.addDate, id: change.id };
        newIndex = bsearchForInsert(this.idsWithDates, newKey,
                                    conversationMessageComparator);
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
    this.emit('change');
  },

  /**
   * Listener for changes on the conversation to detect when it's deleted so we
   * can clean ourselves out.  No TOC events are generated in this case.
   */
  onConvChange: function(convId, convInfo) {
    if (convInfo === null) {
      // Our conversation was deleted and no longer exists.  Clean everything
      // out.
      this.idsWithDates.splice(0, this.idsWithDates.length);
      this.emit('change', null);
    }
  },

  /**
   * Return an array of the conversation id's occupying the given indices.
   */
  sliceIds: function(begin, end) {
    let ids = [];
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
                                 conversationMessageComparator);
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
    // data we were able to provide synchronously.  (And the stuff we have to
    // read from the DB does NOT go in here.)
    let newKnownSet = new Set();

    let idsWithDates = this.idsWithDates;
    let headerCache = this._db.headerCache;
    let ids = [];
    for (let i = beginInclusive; i < endExclusive; i++) {
      let id = idsWithDates[i].id;
      ids.push(id);
      if (alreadyKnown.has(id)) {
        newKnownSet.add(id);
        continue;
      }
      if (headerCache.has(id)) {
        newKnownSet.add(id);
        haveData.set(id, headerCache.get(id));
      } else {
        let date = idsWithDates[i].id;
        needData.set([id, date], null);
      }
    }

    let readPromise = null;
    if (needData.size) {
      readPromise = this._db.read(this, {
        headers: needData
      });
    } else {
      needData = null;
    }

    return {
      ids: ids,
      state: haveData,
      pendingReads: needData,
      readPromise: readPromise,
      newKnownSet: newKnownSet
    };
  }
}));

return ConversationTOC;
});
