import { effectiveAuthorGivenReplyTo, addressPairFromIdentity,
        replyToFromIdentity } from './address_helpers';

import { generateReplySubject, generateReplyParts } from '../bodies/mailchew';

import replyAllRecipients from './reply_all_recipients';
import replyToSenderRecipients from './reply_to_sender_recipients';

import { makeMessageInfo, makeDraftInfo } from '../db/mail_rep';

/**
 * Given a populated MessageInfo, derive a new MessageInfo that is a reply to
 * that message.  This is an inherently asynchronous process.
 */
export default async function deriveQuotedReply({ sourceMessage, replyMode, identity,
                                     messageId, umid, guid, date, folderIds }) {
  // -- Figure out the recipients
  let sourceRecipients = {
    to: sourceMessage.to,
    cc: sourceMessage.cc,
    bcc: sourceMessage.bcc
  };
  let sourceEffectiveAuthor =
    effectiveAuthorGivenReplyTo(sourceMessage.author, sourceMessage.replyTo);
  let replyEffectiveAuthor =
    effectiveAuthorGivenReplyTo(
      identity, identity.replyTo && { address: identity.replyTo });

  let recipients;
  switch (replyMode) {
    case 'sender':
      recipients = replyToSenderRecipients(
        sourceRecipients, sourceEffectiveAuthor, replyEffectiveAuthor);
      break;
    case 'all':
      recipients = replyAllRecipients(
        sourceRecipients, sourceEffectiveAuthor, replyEffectiveAuthor);
      break;
    default:
      throw new Error('bad reply mode: ' + replyMode);
  }

  // -- Build the references
  let references = sourceMessage.references.slice();
  // (ActiveSync does not provide a guid; references will be empty too, but
  // pushing an invalid thing would be bad.)
  if (sourceMessage.guid) {
    references.push(sourceMessage.guid);
  }

  // -- Subject
  let subject = generateReplySubject(sourceMessage.subject);

  // -- Build the body
  let bodyReps = await generateReplyParts(
    sourceMessage.bodyReps,
    // Used for the "{author} wrote" bit, which favors display name, so
    // allowing the non-SPF-verified reply-to versus the maybe-SPF-verified
    // true sender doesn't matter because the display name is utterly spoofable.
    sourceEffectiveAuthor,
    date,
    identity,
    sourceMessage.guid
  );

  let draftInfo = makeDraftInfo({
    draftType: 'reply',
    mode: replyMode,
    refMessageId: sourceMessage.id,
    refMessageDate: sourceMessage.date
  });

  return makeMessageInfo({
    id: messageId,
    umid,
    guid,
    date,
    author: addressPairFromIdentity(identity),
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.cc,
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
    references,
    bodyReps,
    draftInfo
  });
}
