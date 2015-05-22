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
  // The number of headers where we have already fetch snippets (or at least
  // tried to).
  let snippetCount = 0;
  let tidbits = [];
  let convHasUnread = false;
  let convHasStarred = false;
  let convHasAttachments = false;
  let convFolderIds = new Set();
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

    // union this header's folderId's into the conversation's.
    for (let folderId of header.folderIds) {
      convFolderIds.add(folderId);
    }

    if (header.snippet !== null) {
      snippetCount++;
    }

    // Add up to MAX_TIDBITS tidbits for unread messages
    if (tidbits.length < MAX_TIDBITS && !isRead) {
      tidbits.push({
        id: header.id,
        date: header.date,
        isRead: isRead,
        isStarred: isStarred,
        hasAttachments: header.hasAttachments,
        author: header.author,
        snippet: header.snippet
      });
    }
  }

  // Display height in quantized units.
  let height = Math.max(2, tidbits.length + 1);

  return {
    id: convId,
    date: headers[headers.length - 1].date,
    folderIds: convFolderIds,
    height: height,
    subject: headers[0].subject,
    headerCount: headers.length,
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
