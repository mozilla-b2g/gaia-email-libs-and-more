define(function(require) {
'use strict';

let co = require('co');
let logic = require('logic');

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

  this.__deactivate(true);
}
ConversationTOC.prototype = evt.mix(RefedResource.mix({
  type: 'ConversationTOC',
  heightAware: false,

  __activate: co.wrap(function*() {
    // NB: Although our signature is for this to just provide us with the id's,
    // this actually has the byproduct of loading the header records and placing
    // them in the cache because we can't currently just get the keys.
    let { idsWithDates, drainEvents, tocEventId, convEventId } =
      yield this._db.loadConversationMessageIdsAndListen(this.convId);

    this.idsWithDates = idsWithDates;
    this._tocEventId = tocEventId;
    this._convEventId = convEventId;
    drainEvents(this._bound_onTOCChange);
    this._db.on(tocEventId, this._bound_onTOCChange);
    this._db.on(convEventId, this._bound_onConvChange);
  }),

  __deactivate: function(firstTime) {
    this.idsWithDates = [];
    if (!firstTime) {
      this._db.removeListener(this._tocEventId, this._bound_onTOCChange);
    }
  },

  get length() {
    return this.idsWithDates.length;
  },

  get totalHeight() {
    return this.idsWithDates.length;
  },

  /**
   * Handle the addition or removal of a message from the TOC.  Note that while
   * we originally tried to stick with the invariant that message dates were
   * immutable, we decided to allow them to change in the case of drafts to
   * allow for simpler conceptual handling.
   *
   * @param {MessageId} messageId
   * @param {DateTS} [preDate]
   *   If the message already existed, its date before the change.  If the
   *   message did not previously exist, this is null.
   * @param {DateTS} [postDate]
   *   If the message has not been deleted, its date after the change.  (Which
   *   should be the same as the date before the change unless the message is a
   *   modified draft.)  If the message has been deleted, this is null.
   * @param {MessageInfo} headerInfo
   * @param {Boolean} freshlyAdded
   */
  onTOCChange: function(messageId, preDate, postDate, headerInfo,
                        freshlyAdded) {
    let metadataOnly = headerInfo && !freshlyAdded;

    if (freshlyAdded) {
      // - Added!
      let newKey = { date: postDate, id: messageId };
      let newIndex = bsearchForInsert(this.idsWithDates, newKey,
                                      conversationMessageComparator);
      this.idsWithDates.splice(newIndex, 0, newKey);
    } else if (!headerInfo) {
      // - Deleted!
      let oldKey = { date: preDate, id: messageId };
      let oldIndex = bsearchMaybeExists(this.idsWithDates, oldKey,
                                        conversationMessageComparator);
      this.idsWithDates.splice(oldIndex, 1);
    } else if (preDate !== postDate) {
      // - Message date changed (this should only happen for drafts)
      let oldKey = { date: preDate, id: messageId };
      let oldIndex = bsearchMaybeExists(this.idsWithDates, oldKey,
                                        conversationMessageComparator);
      this.idsWithDates.splice(oldIndex, 1);

      let newKey = { date: postDate, id: messageId };
      let newIndex = bsearchForInsert(this.idsWithDates, newKey,
                                      conversationMessageComparator);
      this.idsWithDates.splice(newIndex, 0, newKey);

      // We're changing the ordering.
      metadataOnly = false;
    }

    this.emit('change', messageId, metadataOnly);
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

  /**
   * Generate an ordering key that is from the distant future, effectively
   * latching us to the top.  We use this for the coordinate-space case where
   * there is nothing loaded yet.
   */
  getTopOrderingKey: function() {
    return {
      date: new Date(2200, 0),
      id: ''
    };
  },

  getOrderingKeyForIndex: function(index) {
    if (this.idsWithDates.length === 0) {
      return this.getTopOrderingKey();
    } else if (index < 0) {
      index = 0;
    } else if (index >= this.idsWithDates.length) {
      index = this.idsWithDates.length - 1;
    }
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
    let messageCache = this._db.messageCache;
    let ids = [];
    for (let i = beginInclusive; i < endExclusive; i++) {
      let id = idsWithDates[i].id;
      ids.push(id);
      if (alreadyKnown.has(id)) {
        newKnownSet.add(id);
        continue;
      }
      if (messageCache.has(id)) {
        newKnownSet.add(id);
        haveData.set(id, messageCache.get(id));
      } else {
        let date = idsWithDates[i].date;
        needData.set([id, date], null);
      }
    }

    let readPromise = null;
    if (needData.size) {
      readPromise = this._db.read(this, {
        messages: needData
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
