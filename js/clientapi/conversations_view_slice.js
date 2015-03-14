define(function(require) {
'use strict';

var BridgedViewSlice = require('./bridged_view_slice');

function ConversationsViewSlice(api, handle, ns) {
  BridgedViewSlice.call(this, api, ns || 'conversations', handle);
}
ConversationsViewSlice.prototype = Object.create(BridgedViewSlice.prototype);

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
