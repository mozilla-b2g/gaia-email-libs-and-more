define(function(require) {
'use strict';

let WindowedListView = require('./windowed_list_view');
let MailConversation = require('./mail_conversation');

function ConversationsViewSlice(api, handle) {
  WindowedListView.call(this, api, MailConversation, handle);
}
ConversationsViewSlice.prototype = Object.create(WindowedListView.prototype);

ConversationsViewSlice.prototype._makeOrderingKeyFromItem = function(item) {
  return {
    date: item.mostRecentMessageDate.valueOf(),
    id: item.id
  };
};

ConversationsViewSlice.prototype.refresh = function() {
  this._api.__bridgeSend({
      type: 'refreshView',
      handle: this._handle
    });
};

ConversationsViewSlice.prototype.grow = function() {
  this._api.__bridgeSend({
      type: 'growView',
      handle: this._handle
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
ConversationsViewSlice.prototype.ensureSnippets = function(idxStart, idxEnd) {
  if (idxStart === undefined) {
    idxStart = 0;
  }
  if (idxEnd === undefined) {
    idxEnd = this.items.length - 1;
  }

  let convIds = [];
  for (let i = idxStart; i < idxEnd; i++) {
    let convInfo = this.items[i];
    if (!convInfo) {
      continue;
    }
    if (convInfo.snippetCount < convInfo.headerCount) {
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

return ConversationsViewSlice;
});
