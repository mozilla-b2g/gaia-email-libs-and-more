/**
 * Gather the messages belonging to the provided conversation.
 *
 * The way this is used in conjunction with our gather definition, our returned
 * result of [msgA, msgB, msgC] will be exploded in the gather context to be
 * [{ message: msgA }, { message: msgB }, { message: msgC }].
 */
export default function GatherConversationMessages({ db, ctx }) {
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
