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

return ConversationsViewSlice;
});
