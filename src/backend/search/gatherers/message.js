/**
 * Fetch a message give its `messageId` and `date`.  Used as a root/bootstrap
 * gatherer, see `msg_gatherers.js` for more details.
 */
export default function GatherMessage({ db, ctx }) {
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
