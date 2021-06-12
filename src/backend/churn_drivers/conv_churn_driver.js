import logic from 'logic';

import appChurnConversation from 'app_logic/conv_churn';

const scope = {};
logic.defineScope(scope, 'churnConversationDriver');

/**
 * Produces the wire representation for a conversation from the list of messages
 * that comprise that conversation.  This implementation derives all of the
 * must-have information required for the `MailConversation`.  However,
 * everything else is farmed out to the function provided by the app-logic at
 * "app_logic/conv_churn" and which will be found under "app" on the produced
 * structure.
 *
 * @param {*} convId
 *   The conversation's canonical id.
 * @param {*} oldConvInfo
 *   If previously churned, the previous state, null if this is a fresh
 *   conversation.
 * @param {MessageInfo[]} messages
 * @param {'mail'|'phab-drev'|'bug'|String} convType
 *   The conversation type allows the app logic for churning to specialize its
 *   behavior, as well as the UI.  We now support a mixture of account types
 *   that aren't all email accounts, and it's counterproductive to try and force
 *   them to all fit into the email model without specialization.
 * @param {*} convMeta
 *   Dictionary of extra information about the conversation itself as a
 *   conceptual entity for the benefit of app logic and any involved extensions.
 *   While this isn't normally a thing for vanilla email, phabricator revisions
 *   and bugzilla bugs are not just container aggregates but first class
 *   entities with attributes that exist independent of what we've mapped into
 *   messages.
 */
export default function churnConversationDriver(convId, oldConvInfo, messages, convType='mail', convMeta) {
  // By default, for email, we want to unique-ify based on email address.
  let userCanonicalField = 'address';
  if (convType === 'phab-drev') {
    userCanonicalField = 'nick';
  }

  let authorsById = new Map();
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

    if (!authorsById.has(message.author[userCanonicalField])) {
      authorsById.set(message.author[userCanonicalField], message.author);
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
    convType,
    date: effectiveDate,
    folderIds: convFolderIds,
    // It's up to the actual churn to clobber the height if it wants.
    height: 1,
    subject: messages[0].subject,
    messageCount: messages.length,
    snippetCount: snippetCount,
    authors: Array.from(authorsById.values()),
    tidbits: tidbits,
    hasUnread: convHasUnread,
    hasStarred: convHasStarred,
    hasDrafts: convHasDrafts,
    hasAttachments: convHasAttachments,
    app: {}
  };

  // TODO: Probably extensions should get a chance to do some digesting here?
  // Or is that something that we should leave up to the app logic so that it
  // can draw from the extensions as a library of helpers to invoke?

  try {
    appChurnConversation(convInfo, messages, oldConvInfo, convType, convMeta);
  } catch (ex) {
    logic(scope, 'appChurnEx', { ex });
  }

  return convInfo;
}
