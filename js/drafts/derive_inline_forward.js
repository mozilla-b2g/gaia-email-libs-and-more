import { addressPairFromIdentity, replyToFromIdentity } from
  './address_helpers';

import { generateForwardSubject, generateForwardParts } from
  '../bodies/mailchew';

import { makeMessageInfo, makeDraftInfo } from '../db/mail_rep';


/**
 * Given a populated MessageInfo, derive a new MessageInfo that is an inline
 * forward of that message.  This is an inherently asynchronous process.
 */
export default async function deriveInlineForward({ sourceMessage, identity, messageId, umid,
                                       guid, date, folderIds }) {
  // -- Subject
  let subject = generateForwardSubject(sourceMessage.subject);

  // -- Build the body
  let bodyReps = await generateForwardParts( sourceMessage, identity);

  let draftInfo = makeDraftInfo({
    draftType: 'forward',
    mode: null,
    refMessageId: sourceMessage.id,
    refMessageDate: sourceMessage.date
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
    subject,
    // There is no user-authored content at this point, so the snippet is empty
    // by definition.  draft_save will update this.
    snippet: '',
    attachments: [],
    relatedParts: [],
    // TODO: in Thunderbird I added a header that indicates the message-id of
    // the message that's getting forwarded for linkage purposes.  While that
    // does not go in here, it's something that would want to go around here in
    // an extra/custom-headers stashing place.
    references: [],
    bodyReps,
    draftInfo
  });
}

