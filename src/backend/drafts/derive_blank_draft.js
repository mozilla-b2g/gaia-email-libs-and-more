define(function(require) {
'use strict';

const { addressPairFromIdentity, replyToFromIdentity } =
  require('./address_helpers');

const { generateBaseComposeParts } =
  require('../bodies/mailchew');

const { makeMessageInfo, makeDraftInfo } = require('../db/mail_rep');

/**
 * Create a blank message, noting that because of signatures this might not
 * actually be fully blank.
 */
return function deriveBlankDraft({ identity, messageId, umid, guid, date,
                                   folderIds }) {
  // -- Build the body
  let bodyReps = generateBaseComposeParts(identity);

  let draftInfo = makeDraftInfo({
    draftType: 'blank',
    mode: null,
    refMessageId: null,
    refMessageDate: null
  });

  return makeMessageInfo({
    id: messageId,
    umid,
    guid,
    date,
    author: addressPairFromIdentity(identity),
    // Forwarded messages have no automatic recipients
    to: [],
    cc: [],
    bcc: [],
    replyTo: replyToFromIdentity(identity),
    flags: [],
    folderIds,
    hasAttachments: false,
    subject: '',
    // There is no user-authored content at this point, so the snippet is empty
    // by definition.  draft_save will update this.
    snippet: '',
    attachments: [],
    relatedParts: [],
    references: [],
    bodyReps,
    draftInfo
  });
};
});
