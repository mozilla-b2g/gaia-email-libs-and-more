define(function(require) {
'use strict';

const { checkIfAddressListContainsAddress, filterOutIdentity } =
  require('./address_helpers');

/**
 * Given the recipients of a message, the (effective after reply-to ingestion)
 * message author, and the author of the about-to-be-created reply, figure out
 * the new set of recipients for the "reply all" situation.
 *
 * The key things are:
 * - Don't put the author of the source message on the to list if they're
 *   already in the to/cc.
 * - The author of the message doesn't need to send the message to themselves.
 *   This makes sense for sanity reasons and to help avoid silly things
 *   happening if someone with a less-clever client does reply-all to this new
 *   reply.
 */
return function replyAllRecipients(sourceRecipients, sourceAuthor,
                                   replyAuthor) {
  let rTo;
  // No need to change the lists if the author is already on the
  // reply lists.
  //
  // nb: Our logic here is fairly simple; Thunderbird's
  // nsMsgCompose.cpp does a lot of checking that we should
  // audit, although much of it could just be related to its
  // much more extensive identity support.
  if (checkIfAddressListContainsAddress(sourceRecipients.to,
                                        sourceAuthor) ||
      checkIfAddressListContainsAddress(sourceRecipients.cc,
                                        sourceAuthor)) {
    rTo = sourceRecipients.to;
  }
  // add the author as the first 'to' person
  else {
    if (sourceRecipients.to && sourceRecipients.to.length) {
      rTo = [sourceAuthor].concat(sourceRecipients.to);
    } else {
      rTo = [sourceAuthor];
    }
  }

  // Special-case a reply-to-self email where the only recipient was the
  // message's own author.  In that case, we do not want to perform the
  // filtering below.
  if (rTo.length === 1 &&
      (!sourceRecipients.cc || sourceRecipients.cc.length === 0) &&
      checkIfAddressListContainsAddress(rTo, replyAuthor)) {
    return {
      to: rTo,
      cc: [],
      bcc: sourceRecipients.bcc
    };
  }

  return {
    to: filterOutIdentity(rTo, replyAuthor),
    cc: filterOutIdentity(sourceRecipients.cc || [], replyAuthor),
    bcc: sourceRecipients.bcc
  };
};
});
