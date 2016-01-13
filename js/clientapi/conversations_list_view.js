define(function(require) {
'use strict';

let WindowedListView = require('./windowed_list_view');
let MailConversation = require('./mail_conversation');

/**
 * ## tocMeta fields ##
 * The following fields will be found on the tocMeta dictionary.  Updates to
 * these values will be announced with a `tocMetaUpdate` event.  Most of these
 * values are actually just things you'd find on MailFolder and accordingly
 * you should go look at MailFolder for documentation on them.  (Or failing
 * that, check out `makeFolderMeta).  There may be some things that exist there
 * that we don't yet expose here that we can easily add.
 *
 * - lastSuccessfulSyncAt {DateMS}
 * - lastAttemptedSyncAt {DateMS}
 * - syncStatus {String}
 * - syncBlocked
 *
 * ## Events ###
 * - syncCompleted: A sync of the folder/whatever has completed.  Primarily
 *   intended to provide a notification of the number of new/updated
 *   conversations as a stateless, transient toaster once a user-initiated
 *   sync has completed.  But this will fire whenever a sync task completes
 *   even if the user didn't initiate it.
 *
 *   If you want to do things like have a persistent tally, then you need to
 *   hack it together yourself or request a feature enhancement in the vein of
 *   the "new_tracking" task.
 *
 *   The value will have the following fields:
 *   - newishCount: The number of conversations that are either entirely new or
 *     that had new messages added to them.
 *
 *   These are values I defined but ended up punting on that you could have as
 *   an enhancement if you think they're useful.  They don't exist now, though!
 *   - syncReason: A string with one of the following values and rationale:
 *     - 'this-view': Somebody called refresh() on this view and then a sync
 *       happened.  Note that this value dominates all other values.  So if you
 *       call refresh() on us while a cronsync is happening, the answer that
 *       would have otherwise been 'cronsync' will end up being 'this-view'.
 *     - 'cronsync': The periodic synchronization backend triggered this.
 *     - 'other': Some other view triggered this or maybe IMAP idle happened
 *       or a stray alpha particle hit the processor or ghosts on caffeine.
 */
function ConversationsListView(api, handle) {
  WindowedListView.call(this, api, MailConversation, handle);
}
ConversationsListView.prototype = Object.create(WindowedListView.prototype);

ConversationsListView.prototype._makeOrderingKeyFromItem = function(item) {
  return {
    date: item.mostRecentMessageDate.valueOf(),
    id: item.id
  };
};

ConversationsListView.prototype.refresh = function() {
  this._api.__bridgeSend({
      type: 'refreshView',
      handle: this.handle
    });
};

ConversationsListView.prototype.grow = function() {
  this._api.__bridgeSend({
      type: 'growView',
      handle: this.handle
    });
};

/**
 * Ensures that an effort has been made to fetch snippets for all of the
 * messages in the conversations in the given inclusive index range.  (Note that
 * this may technically be overkill for any given conversation since not all the
 * snippets are likely to be displayed as part of the conversation summary.
 * However, in most UIs, being able to see the conversation summary is likely
 * to imply the ability to see the list of messages, in which case the snippets
 * are really desired, so it makes sense to couple this.  Note that
 * HeadersViewSlice also exposes an `ensureSnippets` method that operates on
 * just its messages/conversation.
 */
ConversationsListView.prototype.ensureSnippets = function(idxStart, idxEnd) {
  if (idxStart === undefined) {
    idxStart = 0;
  }
  if (idxEnd === undefined) {
    idxEnd = this.items.length - 1;
  }

  let convIds = [];
  for (let i = idxStart; i <= idxEnd; i++) {
    let convInfo = this.items[i];
    if (!convInfo) {
      continue;
    }
    if (convInfo.snippetCount < convInfo.messageCount) {
      convIds.push(convInfo.id);
    }
  }

  if (!convIds.length) {
    return false;
  }

  // NB: We intentionally do not use a handle as there's no reason this needs to
  // be statefully associated with a list view.
  this._api.__bridgeSend({
    type: 'fetchSnippets',
    convIds: convIds
  });
};

return ConversationsListView;
});
