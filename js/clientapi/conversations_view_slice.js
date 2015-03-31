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

/**
 * Request a re-sync of the time interval covering the effective time
 * range.  If the most recently displayed message is the most recent message
 * known to us, then the date range will cover through "now".  The refresh
 * mechanism will disable normal sync bisection limits, so take care to
 * `requestShrinkage` to a reasonable value if you have a ridiculous number of
 * headers currently present.
 */
ConversationsViewSlice.prototype.refresh = function() {
  this._api.__bridgeSend({
      type: 'refreshConversations',
      handle: this._handle
    });
};

return ConversationsViewSlice;
});
