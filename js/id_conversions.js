define(function(require) {
'use strict';

return {
  // -- From Conversation Id's
  // These look like: "accountId.gmailConvId"
  accountIdFromConvId: function(convId) {
    return convId.split(/\./g, 1)[0];
  },

  encodedGmailConvIdFromConvId: function(convId) {
    let idxFirst = convId.indexOf('.');
    return convId.substring(idxFirst + 1);
  },

  // -- From Message Id's
  // These look like:
  // "account.gmail conversation id.gmail message id.all mail folder uid"

  /**
   * @return {AccountId}
   *   The string identifier for the account.
   */
  accountIdFromMessageId: function(messageId) {
    return messageId.split(/\./g, 1)[0];
  },

  /**
   * @return {ConversationId}
   *   The sufficiently unique conversation id that is really
   *   "account id.encoded gmail conversation id".
   */
  convIdFromMessageId: function(messageId) {
    let idxFirst = messageId.indexOf('.');
    let idxSecond = messageId.indexOf('.', idxFirst + 1);
    return messageId.substring(0, idxSecond);
  },

  encodedGmailConvIdFromMessageId: function(messageId) {
    return messageId.split(/\./g, 2)[1];
  },

  encodedGmailMessageIdFromMessageId: function(messageId) {
    return messageId.split(/\./g, 3)[2];
  },

  stringUidFromMessageId: function(messageId) {
    return messageId.split(/\./g, 4)[3];
  },

};
});
