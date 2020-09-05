/**
 * STILL UNDER CONSIDERATION.  Trying the redux approach for now.  Partial
 * rationale is that to simplify this implementation, I would ideally not allow
 * this to be instantiated until the backend has sufficiently bootstrapped
 * enough to have sent the account and per-account folder lists in their
 * entirety.  But gaia mail, for example, generally tries to have its
 * abstractions be able to handle the backend not having been spun up at all,
 * etc.
 *
 * Captures the state of coordinated account/folder-ish/conversation/message
 * browsing and provides related helper logic.
 *
 * When reading/browsing conversations/messages, there is an inherent hierarchy
 * going on.  Because of our use of a backing database and worker, there's also
 * some inherent short-lived asynchrony going on.  If persisting UI state
 * externally and restoring it, there's also the chance for things to no longer
 * exist due to delete folders/conversations/messages.  BrowseContext attempts
 * to deal with this once for all clients.  (It is also able to almost
 * completely eliminate some asynchrony by tricks like leveraging the
 * always-existing accounts slices and their folder slices.  Cleaner consumer
 * code is likely to use the more straightforward and logically independent
 * getConversation/etc. which end up with the short-lived asynchrony problem.)
 *
 * In particular:
 *
 * - Navigation requests that involve short-lived asynchrony pretend like the
 *   request didn't happen until the short-lived asynchrony is addressed.  For
 *   example, if switching folders, we will avoid announcing the folder switch
 *   until
 */
export default function BrowseContext({ api }) {
  this._api = api;
}
BrowseContext.prototype = {
  selectAccount: function(account) {

  },

  selectAccountId: function(accountId) {

  },

  selectFolder: function(folder) {

  },

  selectFolderId: function(folderId) {

  },

  selectConversation: function(conversation) {

  },

  selectConversationId: function(conversationId) {

  },

  selectMessage: function(message) {

  },

  selectMessageId: function(messageId) {

  }
};
