/**
 * Centralize the creation of our header and body object representations.
 *
 * We provide constructor functions which take input objects that should
 * basically look like the output object, but the function enforces
 * consistency and provides the ability to assert about the state of the
 * representation at the call-site.  We discussed making sure to check
 * representations when we are inserting records into our database, but we
 * might also want to opt to do it at creation time too so we can explode
 * slightly closer to the source of the problem.
 *
 * This module will also provide representation checking functions to make
 * sure all the data structures are well-formed/have no obvious problems.
 *
 * @module mailapi/db/mail_rep
 **/

define(function() {
'use strict';

/**
 * @typedef {Object} MessageInfo
 * @property {MessageId} id
 *   The canonical message identifier.  This is conceptually four components:
 *   "account.gmail conversation id.gmail message id.all mail folder uid".
 *   Since convId's are themselves "account.gmail conversation id", this can
 *   also be thought of as "convId.gmail message id.all mail folder uid".  If
 *   the message is not in the all mail folder because it is spam or in the
 *   trash some type of sentinel value is used.
 * @property {String} [guid]
 *   The contents of the message-id header for the message, if available.  (Not
 *   available for ActiveSync.)
 * @property {DateMS} date
 *   The INTERNALDATE corresponding to the message.  This is held immutable.  If
 *   it changes you need to delete the record and re-add it.
 * @property {NameAddressPair} author
 * @property {NameAddressPair[]} to
 * @property {NameAddressPair[]} cc
 * @property {NameAddressPair[]} bcc
 * @property {NameAddressPair[]} replyTo
 * @property {String[]} flags
 * @property {String[]} folderIds
 *   Gmail labels applied to the message.  These may or may not be the same as
 *   what is applied to the rest of the conversation.  Gmail tracks labels on a
 *   per-message basis, at least for IMAP purposes.
 * @property {Boolean} hasAttachments
 *   Does the message potentially have attachments?
 *   XXX This is potentially moot since headers/bodies got merged, but this
 *   could make sense for POP3 for us to indicate uncertainty about the
 *   existence of attachments here without having to tell lies in the
 *   attachments array.
 * @property {String} [subject]
 * @property {String} [snippet]
 *   If null, we haven't tried to generate a snippet yet.
 *
 *   If an empty string, we tried to generate a snippet but got nothing useful.
 *   Note that we may try and generate a snippet from a partial body fetch; this
 *   does not indicate that we should avoid computing a better snippet.
 *   Whenever the snippet is falsey and we have retrieved more body data, we
 *   should always try and derive a snippet.
 *
 *   A non-empty string means we managed to produce some snippet data.  It is
 *   still appropriate to regenerate the snippet if more body data is fetched
 *   since our snippet may be a fallback where we chose quoted text instead of
 *   text authored by the author of the message, etc.
 * @property {AttachmentInfo} [attaching]
 *   Because of memory limitations, we need to encode and attach attachments
 *   in small pieces.  An attachment in the process of being attached is
 *   stored here until fully processed.  Its 'file' field contains a list of
 * @property {AttachmentInfo[]} attachments
 *   Explicit attachments.
 * @property {AttachmentInfo[]} [relatedParts]
 *   Attachments for inline display in the contents of the (hopefully)
 *   multipart/related message.
 * @property {String[]} [references]
 *   The contents of the references header as a list of de-quoted ('<' and
 *   '>' removed) message-id's.  If there was no header, this is null.
 * @property {BodyPartInfo[]} bodyReps
 *   Information on the message body that is only for full message display.
 *   The to/cc/bcc information may get moved up to the header in the future,
 *   but our driving UI doesn't need it right now.
 */
function makeMessageInfo(raw) {
  // All messages absolutely need the following; the caller needs to make up
  // values if they're missing.
  if (!raw.author) {
    throw new Error('No author?!');
  }
  if (!raw.date) {
    throw new Error('No date?!');
  }
  if (!raw.attachments || !raw.bodyReps) {
    throw new Error('No attachments / bodyReps?!');
  }
  // We also want/require a valid id, but we check that at persistence time
  // since POP3 assigns the id/suid slightly later on.  We check the suid at
  // that point too.  (Checked in FolderStorage.addMessageHeader.)

  return {
    id: raw.id,
    guid: raw.guid || null,
    date: raw.date,
    author: raw.author,
    to: raw.to || null,
    cc: raw.cc || null,
    bcc: raw.bcc || null,
    replyTo: raw.replyTo || null,
    flags: raw.flags || [],
    folderIds: raw.folderIds || [],
    hasAttachments: raw.hasAttachments || false,
    // These can be empty strings which are falsey, so no ||
    subject: (raw.subject != null) ? raw.subject : null,
    snippet: (raw.snippet != null) ? raw.snippet : null,
    attachments: raw.attachments,
    relatedParts: raw.relatedParts || null,
    references: raw.references || null,
    bodyReps: raw.bodyReps
  };
}

 /**
  * @typedef {Object} BodyPartInfo
  * @prop {'plain'|'html'} type
  *   The type/kind/variety of body-part.  This is not a MIME type or really
  *   even sub-type.  We have specific representations for plain and HTML types,
  *   this is saying which is which in a self-describing way.
  * @prop {String} part
  *   IMAP part number.  This comes from the server's BODYSTRUCTURE and should
  *   be thought of as an opaque value.
  * @prop {Number} sizeEstimate
  *   The exact size of the body part as reported by the server to us.  But the
  *   server itself may be estimating so care must be taken when specifying
  *   exact byte ranges since the body part may end up being longer.  Note that
  *   this differs from the AttachmentInfo's sizeEstimate which is a guess at
  *   the size of the file after decoding.
  * @prop {Number} amountDownloaded
  *   How many bytes have we downloaded so far?  This happens when we do snippet
  *   fetching.  In this case, this value should exactly match the size of the
  *   `_partInfo.pendingBuffer` Blob.  As such, this value can probably be
  *   discarded.  TODO: nuke this value.
  * @prop {Boolean} isDownloaded
  *   Has this part been fully downloaded?  Because sizeEstimate can be a lie,
  *   it's possible for us to have downloaded sizeEstimate bytes but still not
  *   have fully downloaded the body part.  So this value should stick around
  *   forever.
  * @prop {RawImapPartInfo} _partInfo
  *   Raw info on the part from browserbox PLUS we annotated `pendingBuffer` on
  *   to the object when doing snippet fetching (and therefore amountDownloaded
  *   > 0 and !isDownloaded).
  * @prop {Blob} contentBlob
  *   A Blob either containing a JSON-serialized quotechew.js representation or
  *   an htmlchew.js sanitized HTML representation, depending on our `type`.
  *   See the relevant files for more detail.
  */
function makeBodyPart(raw) {
  // We don't persist body types to our representation that we don't understand.
  if (raw.type !== 'plain' &&
      raw.type !== 'html') {
    throw new Error('Bad body type: ' + raw.type);
  }
  // 0 is an okay body size, but not giving us a guess is not!
  if (raw.sizeEstimate === undefined) {
    throw new Error('Need size estimate!');
  }

  return {
    type: raw.type,
    part: raw.part || null,
    sizeEstimate: raw.sizeEstimate,
    amountDownloaded: raw.amountDownloaded || 0,
    isDownloaded: raw.isDownloaded || false,
    _partInfo: raw._partInfo || null,
    contentBlob: raw.contentBlob || null
  };
}


/*
 * @typedef[AttachmentInfo @dict[
 *   @key[name String]{
 *     The filename of the attachment, if any.
 *   }
 *   @key[contentId String]{
 *     The content-id of the attachment if this is a related part for inline
 *     display.
 *   }
 *   @key[type String]{
 *     The (full) mime-type of the attachment.
 *   }
 *   @key[part String]{
 *     The IMAP part number for fetching the attachment.
 *   }
 *   @key[encoding String]{
 *     The encoding of the attachment so we know how to decode it.  For
 *     ActiveSync, the server takes care of this for us so there is no encoding
 *     from our perspective.  (Although the attachment may get base64 encoded
 *     for transport in the inline case, but that's a protocol thing and has
 *     nothing to do with the message itself.)
 *   }
 *   @key[sizeEstimate Number]{
 *     Estimated file size in bytes.  Gets updated to be the correct size on
 *     attachment download.
 *   }
 *   @key[file @oneof[
 *     @case[null]{
 *       The attachment has not been downloaded, the file size is an estimate.
 *     }
 *     @case[@list["device storage type" "file path"]{
 *       The DeviceStorage type (ex: pictures) and the path to the file within
 *       device storage.
 *     }
 *     @case[HTMLBlob]{
 *       The Blob that contains the attachment.  It can be thought of as a
 *       handle/name to access the attachment.  IndexedDB in Gecko stores the
 *       blobs as (quota-tracked) files on the file-system rather than inline
 *       with the record, so the attachments don't need to count against our
 *       block size since they are not part of the direct I/O burden for the
 *       block.
 *     }
 *     @case[@listof[HTMLBlob]]{
 *       For draft messages, a list of one or more pre-base64-encoded attachment
 *       pieces that were sliced up in chunks due to Gecko's inability to stream
 *       Blobs to disk off the main thread.
 *     }
 *   ]]
 *   @key[charset @oneof[undefined String]]{
 *     The character set, for example "ISO-8859-1".  If not specified, as is
 *     likely for binary attachments, this should be null.
 *   }
 *   @key[textFormat @oneof[undefined String]]{
 *     The text format, for example, "flowed" for format=flowed.  If not
 *     specified, as is likely for binary attachments, this should be null.
 *   }
 * ]]
 */
function makeAttachmentPart(raw) {
  // Something is very wrong if there is no size estimate.
  if (raw.sizeEstimate === undefined) {
    throw new Error('Need size estimate!');
  }

  return {
    // XXX ActiveSync may leave this null, although it's conceivable the
    // server might do normalization to save us.  This needs a better treatment.
    // IMAP generates a made-up name for us if there isn't one.
    name: (raw.name != null) ? raw.name : null,
    contentId: raw.contentId || null,
    type: raw.type || 'application/octet-stream',
    part: raw.part || null,
    encoding: raw.encoding || null,
    sizeEstimate: raw.sizeEstimate,
    file: raw.file || null,
    charset: raw.charset || null,
    textFormat: raw.textFormat || null
  };
}

return {
  makeMessageInfo: makeMessageInfo,
  makeBodyPart: makeBodyPart,
  makeAttachmentPart: makeAttachmentPart
};

}); // end define
