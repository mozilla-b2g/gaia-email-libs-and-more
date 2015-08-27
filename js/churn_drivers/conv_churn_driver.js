define(function(require) {
'use strict';

const logic = require('logic');

const appChurnConversation = require('app_logic/conv_churn');

const scope = {};
logic.defineScope(scope, 'churnConversationDriver');

/**
 * Produces the wire representation for a conversation from the list of messages
 * that comprise that conversation.  This implementation derives all of the
 * must-have information required for the `MailConversation`.  However,
 * everything else is farmed out to the function provided by the app-logic at
 * "app_logic/conv_churn" and which will be found under "app" on the produced
 * structure.
 */
return function churnConversationDriver(convId, oldConvInfo, messages) {
  let authorsByEmail = new Map();
  // The number of headers where we have already fetch snippets (or at least
  // tried to).
  let snippetCount = 0;
  let tidbits = [];
  let convHasUnread = false;
  let convHasStarred = false;
  let convHasDrafts = false;
  let convHasAttachments = false;
  let convFolderIds = new Set();
  // At least for now, the effective date is the most recent non-draft message.
  let effectiveDate = 0;
  let fallbackDate = 0;
  for (let message of messages) {
    let isRead = message.flags.indexOf('\\Seen') !== -1;
    let isStarred = message.flags.indexOf('\\Flagged') !== -1;
    let isDraft = message.draftInfo !== null;

    fallbackDate = Math.max(fallbackDate, message.date);
    if (isDraft) {
      convHasDrafts = true;
    } else {
      effectiveDate = Math.max(effectiveDate, message.date);
    }

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
  }

  if (!effectiveDate) {
    effectiveDate = fallbackDate;
  }

  let convInfo = {
    id: convId,
    date: effectiveDate,
    folderIds: convFolderIds,
    // It's up to the actual churn to clobber the height if it wants.
    height: 1,
    subject: messages[0].subject,
    messageCount: messages.length,
    snippetCount: snippetCount,
    authors: Array.from(authorsByEmail.values()),
    tidbits: tidbits,
    hasUnread: convHasUnread,
    hasStarred: convHasStarred,
    hasDrafts: convHasDrafts,
    hasAttachments: convHasAttachments,
    app: {}
  };

  try {
    appChurnConversation(convInfo, messages, oldConvInfo);
  } catch (ex) {
    logic(scope, 'appChurnEx', { ex });
  }

  return convInfo;
};
});
