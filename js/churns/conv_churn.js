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
function churnConversation(convId, oldConvInfo, messages) {
  let authorsByEmail = new Map();
  // The number of headers where we have already fetch snippets (or at least
  // tried to).
  let snippetCount = 0;
  let tidbits = [];
  let convHasUnread = false;
  let convHasStarred = false;
  let convHasAttachments = false;
  let convFolderIds = new Set();
  for (let message of messages) {
    let isRead = message.flags.indexOf('\\Seen') !== -1;
    let isStarred = message.flags.indexOf('\\Flagged') !== -1;

    if (!isRead) {
      convHasUnread = true;
    }
    if (isStarred) {
      convHasStarred = true;
    }
    if (message.hasAttachments) {
      convHasAttachments = true;
    }

    if (!authorsByEmail.has(message.author.address)) {
      authorsByEmail.set(message.author.address, message.author);
    }

    // union this messages's folderId's into the conversation's.
    for (let folderId of message.folderIds) {
      convFolderIds.add(folderId);
    }

    if (message.snippet !== null) {
      snippetCount++;
    }

    // Add up to MAX_TIDBITS tidbits for unread messages
    if (tidbits.length < MAX_TIDBITS && !isRead) {
      tidbits.push({
        id: message.id,
        date: message.date,
        isRead: isRead,
        isStarred: isStarred,
        hasAttachments: message.hasAttachments,
        author: message.author,
        snippet: message.snippet
      });
    }
  }

  // Display height in quantized units.
  let height = Math.max(2, tidbits.length + 1);

  return {
    id: convId,
    date: messages[messages.length - 1].date,
    folderIds: convFolderIds,
    height: height,
    subject: messages[0].subject,
    messageCount: messages.length,
    snippetCount: snippetCount,
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
