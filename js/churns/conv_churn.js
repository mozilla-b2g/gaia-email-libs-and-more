define(function(require) {
'use strict';

/**
 * How many tidbits should we cram in a conversation summary?
 */
const MAX_TIDBITS = 3;

/**
 * Produce a conversationInfo summary given all of the currently existing
 * headers in the conversation ordered from oldest to newest.
 */
function churnConversation(convId, oldConvInfo, headers) {
  let authorsByEmail = new Map();
  let tidbits = [];
  let convHasUnread = false;
  let convHasStarred = false;
  let convHasAttachments = false;
  for (let header of headers) {
    let isRead = header.flags.indexOf('\\Seen') !== -1;
    let isStarred = header.flags.indexOf('\\Flagged') !== -1;

    if (!isRead) {
      convHasUnread = true;
    }
    if (isStarred) {
      convHasStarred = true;
    }
    if (header.hasAttachments) {
      convHasAttachments = true;
    }

    if (!authorsByEmail.has(header.author.address)) {
      authorsByEmail.set(header.author.address, header.author);
    }

    // Add up to MAX_TIDBITS tidbits for unread messages
    if (tidbits.length < MAX_TIDBITS && !isRead) {
      tidbits.push({
        date: header.date,
        isRead: isRead,
        isStarred: isStarred,
        hasAttachments: header.hasAttachments,
        author: header.author,
        snippet: header.snippet
      });
    }
  }

  return {
    id: convId,
    date: headers[headers.length - 1].date,
    subject: headers[0].subject,
    authors: Array.from(authorsByEmail.values()),
    tidbits: tidbits,
    hasUnread: convHasUnread,
    hasStarred: convHasStarred,
    // no draft support right now
    hasDraft: false,
    hasAttachments: convHasAttachments
  };
}

return churnConversation;
});
