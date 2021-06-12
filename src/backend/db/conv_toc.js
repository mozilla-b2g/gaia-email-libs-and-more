import logic from 'logic';

import { bsearchMaybeExists, bsearchForInsert } from 'shared/util';

import BaseTOC from './base_toc';

import { conversationMessageComparator } from './comparators';

/**
 * The Conversation Table-of-Contents is in charge of backing view slices
 * listing the messages in a specific conversation.
 *
 * This primarily entails tracking how many messages there are in the
 * conversation and maintaining an ordering of all those messages so that if
 * a request comes in for messages by position that we can issue the database
 * requests for them.   There are a lot of similarities between this
 * implementation and FolderConversationsTOC and some unification may be
 * possible.  (Originally there was a simplification where we assumed message
 * dates could not change, but we altered that for drafts whose dates do change
 * as they are edited and when they are finally sent.)
 *
 * This is a reference-counted object that is created on-demand as soon as a
 * view slice is requested for a given conversation and destroyed once no more
 * view slices care about.
 */
export default function ConversationTOC({ db, query, dataOverlayManager }) {
  BaseTOC.apply(this, arguments);

  logic.defineScope(this, 'ConversationTOC');

  this._db = db;
  this.query = query;

  // We share responsibility for providing overlay data with the list proxy.
  // Our getDataForSliceRange performs the resolving, but we depend on the proxy
  // to be listening for overlay updates and to perform appropriate dirtying.
  this._overlayResolver = dataOverlayManager.makeBoundResolver(
    this.overlayNamespace, null);

  this.__deactivate(true);
}
ConversationTOC.prototype = BaseTOC.mix({
  type: 'ConversationTOC',
  overlayNamespace: 'messages',
  heightAware: false,

  async __activateTOC() {
    // NB: Although our signature is for this to just provide us with the id's,
    // this actually has the byproduct of loading the header records and placing
    // them in the cache because we can't currently just get the keys.
    let idsWithDates = await this.query.execute();

    // Sort the IDs in the same order as used by the binary search used later
    // for modifications done with this class.
    idsWithDates.sort(conversationMessageComparator);

    this.idsWithDates = idsWithDates;
    this.query.bind(this, this.onTOCChange, this.onConvChange);
  },

  __deactivateTOC(firstTime) {
    this.idsWithDates = [];
    if (!firstTime) {
      this.query.destroy(this);
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
   * @param {MessageId} change.id
   * @param {DateTS} [preDate]
   *   If the message already existed, its date before the change.  If the
   *   message did not previously exist, this is null.
   * @param {DateTS} [postDate]
   *   If the message has not been deleted, its date after the change.  (Which
   *   should be the same as the date before the change unless the message is a
   *   modified draft.)  If the message has been deleted, this is null.
   * @param {MessageInfo} item
   * @param {Boolean} freshlyAdded
   */
  onTOCChange({ id, preDate, postDate, item, freshlyAdded, matchInfo }) {
    let metadataOnly = item && !freshlyAdded;

    if (freshlyAdded) {
      // - Added!
      let newKey = { date: postDate, id, matchInfo };
      let newIndex = bsearchForInsert(this.idsWithDates, newKey,
                                      conversationMessageComparator);
      this.idsWithDates.splice(newIndex, 0, newKey);
    } else if (!item) {
      // - Deleted!
      let oldKey = { date: preDate, id };
      let oldIndex = bsearchMaybeExists(this.idsWithDates, oldKey,
                                        conversationMessageComparator);
      this.idsWithDates.splice(oldIndex, 1);
    } else if (preDate !== postDate) {
      // - Message date changed (this should only happen for drafts)
      let oldKey = { date: preDate, id };
      let oldIndex = bsearchMaybeExists(this.idsWithDates, oldKey,
                                        conversationMessageComparator);
      this.idsWithDates.splice(oldIndex, 1);

      let newKey = { date: postDate, id, matchInfo };
      let newIndex = bsearchForInsert(this.idsWithDates, newKey,
                                      conversationMessageComparator);
      this.idsWithDates.splice(newIndex, 0, newKey);

      // We're changing the ordering.
      metadataOnly = false;
    }

    this.emit('change', id, metadataOnly);
  },

  /**
   * Listener for changes on the conversation to detect when it's deleted so we
   * can clean ourselves out.  No TOC events are generated in this case.
   */
  onConvChange(convId, convInfo) {
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
  sliceIds(begin, end) {
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
  getTopOrderingKey() {
    return {
      date: new Date(2200, 0),
      id: ''
    };
  },

  getOrderingKeyForIndex(index) {
    if (this.idsWithDates.length === 0) {
      return this.getTopOrderingKey();
    } else if (index < 0) {
      index = 0;
    } else if (index >= this.idsWithDates.length) {
      index = this.idsWithDates.length - 1;
    }
    return this.idsWithDates[index];
  },

  findIndexForOrderingKey(key) {
    let index = bsearchForInsert(this.idsWithDates, key,
                                 conversationMessageComparator);
    return index;
  },

  getDataForSliceRange(beginInclusive, endExclusive,
      alreadyKnownData, alreadyKnownOverlays) {
    beginInclusive = Math.max(0, beginInclusive);
    endExclusive = Math.min(endExclusive, this.idsWithDates.length);

    let overlayResolver = this._overlayResolver;

    // State and overlay data to be sent to our front-end view counterpart.
    // This is (needed) state information we have synchronously available from
    // the db cache and (needed) overlay information (which can always be
    // synchronously derived.)
    let sendState = new Map();
    // Things we need to request from the database.  (Although MailDB.read will
    // immediately populate the things we need, WindowedListProxy's current
    // wire protocol calls for omitting things we don't have the state for yet.
    // And it's arguably nice to avoid involving going async here with flushes
    // and all that if we can avoid it.
    let needData = new Map();
    // The new known set which is the stuff from alreadyKnownData we reused plus
    // the data we were able to provide synchronously.  (And the stuff we have
    // to read from the DB does NOT go in here.)
    let newKnownSet = new Set();

    let idsWithDates = this.idsWithDates;
    let messageCache = this._db.messageCache;
    let ids = [];
    for (let i = beginInclusive; i < endExclusive; i++) {
      let id = idsWithDates[i].id;
      ids.push(id);
      let haveData = alreadyKnownData.has(id);
      let haveOverlays = alreadyKnownOverlays.has(id);
      if (haveData && haveOverlays) {
        newKnownSet.add(id);
        continue;
      }

      if (haveData) {
        // only need overlays
        sendState.set(id, [null, overlayResolver(id)]);
      } else if (messageCache.has(id)) {
        newKnownSet.add(id);
        sendState.set(
          id,
          [
            messageCache.get(id),
            overlayResolver(id),
            idsWithDates[i].matchInfo
          ]);
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
      state: sendState,
      pendingReads: needData,
      readPromise,
      newValidDataSet: newKnownSet
    };
  }
});
