define(function(require) {
'use strict';

let evt = require('evt');
let ContactCache = require('./contact_cache');

/**
 * @typedef {Object} ConvMsgTidbit
 *
 * Summary info on an interesting/notable message in a conversation.  Note that
 * this is not something that updates.  The conversation updates and these will
 * be completely replaced.  Do not keep references, etc.
 *
 * @property {Date} date
 * @property {Boolean} isRead
 * @property {Boolean} isStarred
 * @property {Boolean} hasAttachments
 * @property {MailPeep} author
 * @property {String} [snippet]
 *   The snippet will eventually show up, but may not be there yet.  The value
 *   will be null if there's no snippet yet or an empty string if we were unable
 *   to derive a snippet from the data we have thus far.
 */

/**
 * It's a conversation summary.  Eventually this will be contain stuff you the
 * API user will control by providing logic that gets bundled in the build step
 * (or quasi-dynamically if we have magic ServiceWorker things).  For now you
 * get the data I deign to provide.  Complain and I'll replace the data with
 * poorly researched facts about puppies.  Consider yourself warned.
 *
 * CURRENT LIMITATION: MailPeep instances will be re-created all the flipping
 * time by us.  Don't bother listening on them for changes because your
 * listeners will go away.  Eventually we'll just deliver a change notification
 * on the conversation as a whole for you if contact stuff happens.
 *
 * @property {GmailConvId} id
 * @property {Date} mostRecentMessageDate
 *   The (received) date of the most recent message in the conversation.  This
 *   provides the ordering of the conversation.
 * @property {Array<MailFolder>} labels
 *   The labels applied to this conversation.  (Actually, the union of the
 *   per-message labels for all of the messages in the conversation.)
 * @property {String} firstSubject
 *   The subject of the originating thread of the message.
 * @property {Array<MailPeep>} authors
 *   The uniqueified list of authors participating in the conversation.  The 0th
 *   index should be the author who started the thread.
 * @property {Array<ConvMsgTidbit>} messageTidbits
 *   You get up to 3 of these
 * @property {Boolean} hasUnread
 * @property {Boolean} hasStarred
 * @property {Boolean} hasDraft
 * @property {Boolean} hasAttachment
 */
function MailConversation(api, wireRep, slice) {
  evt.Emitter.call(this);
  this._api = api;
  this._slice = slice;

  // Store the wireRep so it can be used for caching.
  this._wireRep = wireRep;

  this.id = wireRep.id;
  this.__update(wireRep, true);
}
MailConversation.prototype = evt.mix({
  toString: function() {
    return '[MailConversation: ' + this.id + ']';
  },
  toJSON: function() {
    return {
      type: 'MailConversation',
      id: this.id
    };
  },

  viewHeaders: function() {
    return this._api.viewConversationHeaders(this);
  },

  _forgetPeeps: function() {
    let tidbitPeeps = this.messageTidbits.map(x => x.author);
    ContactCache.forgetPeepInstances(this.authors, tidbitPeeps);
  },

  __update: function(wireRep, firstTime) {
    this._wireRep = wireRep;

    // Delta-computing peeps is hard, forget them all then re-resolve them all.
    // We have a cache.  It's fine.
    if (!firstTime) {
      this._forgetPeeps();
    }

    this.mostRecentMessageDate = new Date(wireRep.date);
    this.firstSubject = wireRep.subject;
    this.headerCount = wireRep.headerCount;
    this.authors = ContactCache.resolvePeeps(wireRep.authors);
    this.messageTidbits = wireRep.tidbits.map((tidbit) => {
      return {
        date: new Date(tidbit.date),
        isRead: tidbit.isRead,
        isStarred: tidbit.isStarred,
        hasAttachments: tidbit.hasAttachments,
        author: ContactCache.resolvePeep(tidbit.author),
        snippet: tidbit.snippet
      };
    });

    // Are there any unread messages in this
    this.hasUnread = wireRep.hasUnread;
    this.hasStarred = wireRep.hasStarred;
    this.hasDraft = wireRep.hasDraft;
    this.hasAttachments = wireRep.hasAttachments;
  },

  /**
   * Clean up all the peeps.
   */
  __die: function() {
    this._forgetPeeps();
  },

});

return MailConversation;
});
