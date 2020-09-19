/**
 * Gather the ConversationInfo for the given conversation.
 */
export default function GatherConversation({ db, ctx }) {
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
