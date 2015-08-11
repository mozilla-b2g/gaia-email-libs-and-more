define(function(require) {
'use strict';


const { addressMatches, cloneRecipients } = require('./address_helpers');

/**
 * Given the original recipients of a message, and the author who wants to reply
 * to that message, figure out the new set of recipients for the normal "reply"
 * logic.  The trick is that if "we" wrote the message we're replying to, then
 * we want to reuse the original to list (ignoring cc/bcc) rather than creating
 * a message to send to ourselves.  This usually happens in the sent folder.
 */
return function replyToSenderRecipients(sourceRecipients, sourceAuthor,
                                        replyAuthor) {
  if (addressMatches(sourceAuthor, replyAuthor)) {
    return cloneRecipients(sourceRecipients);
  } else {
    return {
      to: [sourceAuthor],
      cc: [],
      bcc: []
    };
  }
};
});
