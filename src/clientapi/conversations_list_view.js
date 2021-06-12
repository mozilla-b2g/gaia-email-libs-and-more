import WindowedListView from './windowed_list_view';
import MailConversation from './mail_conversation';

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
 * - syncComplete: A sync of the folder/whatever has completed.  Primarily
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
 *   - thisViewTriggered: Did this ConversationsListView initiate the sync (or
 *     otherwise join up with some active sync)?
 */
export default function ConversationsListView(api, handle) {
  WindowedListView.call(this, api, MailConversation, handle);

  /**
   * Track whether there's an outstanding sync/grow call so that we can decorate
   * the syncComplete notification with extra data.
   */
  this.syncRequested = false;

  // Get at the front of the syncComplete line so we can clobber data onto it.
  // We get our own structured clone copy, so this mutation is safe since the
  // only instance it affects is ours, and we only want the post-mutation state.
  this.on('syncComplete', (data) => {
    data.thisViewTriggered = this.syncRequested;
    this.syncRequested = false;
  });
}
ConversationsListView.prototype = Object.create(WindowedListView.prototype);

ConversationsListView.prototype._makeOrderingKeyFromItem = function(item) {
  return {
    date: item.mostRecentMessageDate.valueOf(),
    id: item.id
  };
};

ConversationsListView.prototype.refresh = function() {
  this.syncRequested = true;
  this._api.__bridgeSend({
      type: 'refreshView',
      handle: this.handle
    });
};

ConversationsListView.prototype.grow = function() {
  this.syncRequested = true;
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
 *
 * Returns false if there was no need to enqueue async snippet fetching, true if
 * there was.
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
  return true;
};
