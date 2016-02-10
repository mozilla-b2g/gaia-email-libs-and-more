define(function() {
'use strict';

/**
 * Given the ConversationInfo for the given conversation.
 */
function GatherMessage({ db, ctx }) {
  this._db = db;
  this._ctx = ctx;
}
GatherMessage.prototype = {
  plural: false,
  gather: function(gathered) {
    // In the event the message isn't in the cache, its date is required.
    let messageKey = [gathered.messageId, gathered.date];
    return this._db.read(
      this._ctx,
      {
        messages: new Map([[messageKey, null]])
      })
    .then(({ messages }) => {
      return messages.get(gathered.messageId);
    });
  }
};
return GatherMessage;
});
