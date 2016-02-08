define(function() {
'use strict';

/**
 * Gather the messages belonging to the provided conversation.
 */
function GatherConversationMessages({ db, ctx }) {
  this._db = db;
  this._ctx = ctx;
}
GatherConversationMessages.prototype = {
  /**
   * Indicate that we return an Array of items that should be spread into their
   * own gather contexts.
   */
  plural: true,
  gather: function(gathered) {
    return this._db.read(
      this._ctx,
      {
        messagesByConversation: new Map([[gathered.convId, null]])
      })
    .then(({ messagesByConversation }) => {
      return messagesByConversation.get(gathered.convId);
    });
  }
};
return GatherConversationMessages;
});
