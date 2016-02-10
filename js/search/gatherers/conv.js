define(function() {
'use strict';

/**
 * Gather the ConversationInfo for the given conversation.
 */
function GatherConversation({ db, ctx }) {
  this._db = db;
  this._ctx = ctx;
}
GatherConversation.prototype = {
  gather: function(gathered) {
    return this._db.read(
      this._ctx,
      {
        conversations: new Map([[gathered.convId, null]])
      })
    .then(({ conversations }) => {
      return conversations.get(gathered.convId);
    });
  }
};
return GatherConversation;
});
