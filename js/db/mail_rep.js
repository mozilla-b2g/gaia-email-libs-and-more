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

/**
 * @typedef {Object} MessageInfo
 * @property {MessageId} id
 *   The canonical message identifier.  This is conceptually four components:
 *   "account.gmail conversation id.gmail message id.all mail folder uid".
 *   Since convId's are themselves "account.gmail conversation id", this can
 *   also be thought of as "convId.gmail message id.all mail folder uid".  If
 *   the message is not in the all mail folder because it is spam or in the
 *   trash some type of sentinel value is used.
 * @property {UniqueMessageId} [umid]
 *   The (account-scoped) unique message identifier that keys into the umidNames
 *   and umidLocations storage for non-conversation-centric protocols where we
 *   need to add some indirection.  See vanilla/sync.md for more details.
 * @property {String} [guid]
 *   The contents of the message-id header for the message, if available.  (Not
 *   available for ActiveSync.)
 * @property {DateMS} date
 *   The INTERNALDATE corresponding to the message.  This is held immutable.  If
 *   it changes you need to delete the record and re-add it.
 * @property {DateMS} [dateModified=date]
 *   For messages that can be edited, this is the date the message was last
 *   edited.
 * @property {NameAddressPair} author
 * @property {NameAddressPair[]} to
 * @property {NameAddressPair[]} cc
 * @property {NameAddressPair[]} bcc
 * @property {NameAddressPair[]} replyTo
 *   Yes, reply-to is a list of addresses.
 * @property {String[]} flags
 * @property {Set} folderIds
 *   Folders this message belongs to.  For Gmail IMAP these correspond to
 *   applied labels and may or may not be the same as what is applied to the
 *   rest of the conversation.  (Gmail tracks labels on a per-message basis, at
 *   least for IMAP purposes.)
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
 *   '>' removed) message-id's.  If there was no header, this is null.  The
 *   references go from oldest to newest.  That is, the 0th reference should be
 *   the root message and the last reference should be the parent.
 * @property {Number} [authoredBodySize]
 *   Best-effort sorta-unitless approximation of the amount of body content that
 *   is new content/authored by the message's author.  The idea is that for a
 *   message that is 10 pages of quoted text from an earlier reply with "+1"
 *   being the only new content, this value conveys that only "+1" is new.
 *
 *   While in the future servers may able to asssist us in estimation, right now
 *   this is the sum of the authoredBodySize over all BodyPartInfo objects, and
 *   they will only be populated as the parts are downloaded.  For both text and
 *   HTML body parts we use the length of the JS string that would be searched
 *   with quotes ignored.  (And all the Unicode implications that go along with
 *   that implementation.)
 * @property {BodyPartInfo[]} bodyReps
 *   The body parts that make up the message.
 * @property {DraftInfo} [draftInfo=null]
 *   If this is a draft, the metadata about the draft.  Note that with our
 *   current continued localdrafts requirement, this also serves as our magic
 *   `isDraft` indicator.
 */
export function makeMessageInfo(raw) {
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
  if (Array.isArray(raw.folderIds)) {
    throw new Error('raw.folderIds must be a Set, not an Array');
  }

  // We also want/require a valid id, but we check that at persistence time
  // since POP3 assigns the id/suid slightly later on.  We check the suid at
  // that point too.  (Checked in FolderStorage.addMessageHeader.)

  return {
    id: raw.id,
    umid: raw.umid || null,
    guid: raw.guid || null,
    date: raw.date,
    dateModified: raw.dateModified || raw.date,
    author: raw.author,
    to: raw.to || null,
    cc: raw.cc || null,
    bcc: raw.bcc || null,
    replyTo: raw.replyTo || null,
    flags: raw.flags || [],
    folderIds: raw.folderIds || new Set(),
    hasAttachments: raw.hasAttachments || false,
    // These can be empty strings which are falsey, so no ||
    subject: (raw.subject != null) ? raw.subject : null,
    snippet: (raw.snippet != null) ? raw.snippet : null,
    attachments: raw.attachments,
    relatedParts: raw.relatedParts || null,
    references: raw.references || null,
    bodyReps: raw.bodyReps,
    authoredBodySize: raw.authoredBodySize || 0,
    draftInfo: raw.draftInfo || null
  };
}

/**
 * Create local-only meta-data to be stored on a MessageInfo that represents a
 * draft.  This is information about a draft that cannot be directly
 * synchronized to a server for some combination of privacy and representation
 * fidelity.  In many cases, if/when we get fancy, we can re-derive some of this
 * information (with ambiguity) by doing some additional processing when saving
 * the information from the server.
 *
 * The compose features this allows us to support:
 * - Marking a replied-to or forwarded message as replied-to/forwarded only
 *   when it has actually been replied-to.  (By knowing the MessageId of the
 *   related message.)
 * - FUTURE: Allowing a draft to change from reply-to-sender to reply-all.
 * - FUTURE: Allowing a draft to change from a reply to a forward (which
 *   requires regenerating the quoted/forwarded body).
 * - FUTURE: Allowin specific identities of an account (or different accounts
 *   with different identities) to be switched between, which potentially means
 *   different signatures and different signature configurations, probably
 *   requiring regeneration of the quoted/forwarded body.
 *
 * Error reporting feedback this allows:
 * - Send failures that seem to be specific to the message (rather than being
 *   offline, etc.) can be conveyed.
 *
 * @typedef {Object} DraftInfo
 * @prop {'blank'|'reply'|'forward'} draftType
 *   The type of message this (currently is).  This cannot change for a draft
 *   at the current time.
 * @prop {'sender'|'all'} [mode=null]
 *   If this is a reply, the type of reply it currently is.  This may also have
 *   meaning in the future when dealing with forwards.
 * @prop {MessageId} [refMessageId=null]
 *   Our local identifier for the message we are replying to/forwarding.
 * @prop {DateMS} [refMessageDate=null]
 *   The date of the message, used for random access to the message without
 *   loading the rest of the messages in the conversation.
 * @prop {Object} [sendProblems=null]
 *   Problems experienced sending the message.  This replaces the v1.x sendInfo
 *   structure which captured both send state and sending problems.
 */
export function makeDraftInfo(raw) {
  return {
    draftType: raw.draftType,
    mode: raw.mode || null,
    refMessageId: raw.refMessageId || null,
    refMessageDate: raw.refMessageDate || null,
    sendProblems: raw.sendProblems || null
  };
}

 /**
  * @typedef {Object} BodyPartInfo
  * @prop {'plain'|'html'|'attr'} type
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
  *   > 0 and !isDownloaded).  TODO: clean this up further, even if it's just
  *   renaming this to rawImapPartInfo.
  * @prop {Blob} contentBlob
  *   A Blob either containing a JSON-serialized quotechew.js representation,
  *   an htmlchew.js sanitized HTML representation, or the 'attr' JSON rep,
  *   depending on our `type`.  See the relevant files for more detail.
  * @prop {Number} authoredBodySize
  *   See comment for `MessageInfo.authoredBodySize`.  But, in short, the
  *   best-effort length of the newly authored content in this body part, as
  *   far as our quoting/boilerplate detection can figure at this time.
  */
export function makeBodyPart(raw) {
  // We don't persist body types to our representation that we don't understand.
  if (raw.type !== 'plain' &&
      raw.type !== 'html' &&
      raw.type !== 'attr') {
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
    contentBlob: raw.contentBlob || null,
    authoredBodySize: raw.authoredBodySize || 0,
  };
}


/**
 * @typedef {Object} AttachmentInfo
 * @prop {String} relId
 *   A unique-inside-this-message identifier for the attachment.  We would use
 *   an absolute identifier (created by prepending the MessageId), but the
 *   potential for the MessageId to change and the hassle of making sure to
 *   update this structure is not justified at this time.  (There is also
 *   a size win for only storing this relative id, but that's really not the
 *   concern.)  In some cases this may end up being the same as the "part",
 *   but the intent is to save us some tears down the road by not conflating the
 *   two purposes (especially if it would break our simple id parsing logic.)
 * @prop {String} name
 *   The filename of the attachment, if any.
 * @prop {String} contentId
 *   The content-id of the attachment if this is a related part for inline
 *   display using the "cid:" protocol.
 * @prop {String} type
 *     The (full) mime-type of the attachment.
 * @prop {String} [part]
 *   For IMAP, the IMAP part number for fetching the attachment.  This is also
 *   used as the basis for the specific part of the AttachmentId for a message
 *   synchronized from the server.  For ActiveSync, this is the server assigned
 *   identifier that we use to fetch things.
 * @prop {String} encoding
 *   The encoding of the attachment so we know how to decode it.  For
 *   ActiveSync, the server takes care of this for us so there is no encoding
 *   from our perspective.  (Although the attachment may get base64 encoded
 *   for transport in the inline case, but that's a protocol thing and has
 *   nothing to do with the message itself.)
 * @prop {Number} sizeEstimate
 *   Estimated file size in bytes.  Gets updated to be the correct size on
 *   attachment download.
 * @prop {null|'cached'|'saved'|'draft'} downloadState
 *   One of the following:
 *   - null: The file is not (fully) downloaded.  It may be in the process of
 *     being downloaded
 *   - 'cached': The file has been downloaded and is being stored in IndexedDB.
 *     It is a single Blob available on `file`.
 *   - 'saved': The file has been saved to DeviceStorage and file contains an
 *     object of the form { storage, path } where `storage` is the device
 *     storage name it was saved to, and `path` is its path within that storage.
 *   - 'draft': The attachment is part of a message draft and is actually an
 *     Array of pre-base64 MIME encoded Blobs.  The attachment is effectively
 *     unviewable because of this.  We will ideally change this in the future
 *     to keep the item raw and instead encode on send.
 * @prop {null|{storage, path}|HTMLBlob|HTMLBlob[]} file
 *   This is one of the following:
 *   - null: The attachment has not been downloaded, the file size is an
 *     estimate.
 *   - ["device storage type" "file path"]: The DeviceStorage type (ex:
 *     pictures) and the path to the file within device storage.
 *   - A Blob/File:
 *     The Blob that contains the attachment.  It can be thought of as a
 *     handle/name to access the attachment.  IndexedDB in Gecko stores the
 *     blobs as (quota-tracked) files on the file-system rather than inline
 *     with the record, so the attachments don't need to count against our
 *     block size since they are not part of the direct I/O burden for the
 *     block.
 *   - An array of Blobs/Files:
 *     For draft messages, a list of one or more pre-base64-encoded attachment
 *     pieces that were sliced up in chunks due to Gecko's inability to stream
 *     Blobs to disk off the main thread.
 * @prop {String} [charset]
 *   The character set, for example "ISO-8859-1".  If not specified, as is
 *   likely for binary attachments, this should be null.
 * @prop {String} [textFormat]
 *   The text format, for example, "flowed" for format=flowed.  If not
 *   specified, as is likely for binary attachments, this should be null.
 */
export function makeAttachmentPart(raw) {
  // Something is very wrong if there is no size estimate.
  if (raw.sizeEstimate === undefined) {
    throw new Error('Need size estimate!');
  }
  if (raw.relId === undefined) {
    throw new Error('attachments need relIds');
  }

  return {
    relId: raw.relId,
    // XXX ActiveSync may leave this null, although it's conceivable the
    // server might do normalization to save us.  This needs a better treatment.
    // IMAP generates a made-up name for us if there isn't one.
    name: (raw.name != null) ? raw.name : null,
    contentId: raw.contentId || null,
    type: raw.type || 'application/octet-stream',
    part: raw.part || null,
    encoding: raw.encoding || null,
    sizeEstimate: raw.sizeEstimate,
    downloadState: raw.downloadState || null,
    file: raw.file || null,
    charset: raw.charset || null,
    textFormat: raw.textFormat || null
  };
}

/**
 * Helper function to pick the given part out of the `attachments` or
 * `relatedParts` by relId.  Obviously this is a trivial find operation right
 * now, but in the event we later change those lists to be Maps, having this
 * helper will maybe have been useful.
 */
export function pickPartByRelId(parts, relId) {
  return parts.find(part => part.relId === relId);
}

/**
 * Given a `MessageInfo` and (self-identifying for this reason) relId, pull the
 * part out of the message or return null.
 *
 * This exists for similar reasons to `pickPartByRelId`.
 */
export function pickPartFromMessageByRelId(messageInfo, relId) {
  // Our part id scheme indicates the type of attachment it is for this
  // specific reason.  Using charCodeAt here would be a little more
  // efficient, but arguably uglier.
  switch (relId[0]) {
    case 'a':
      return pickPartByRelId(messageInfo.attachments, relId);
    case 'r':
      return pickPartByRelId(messageInfo.relatedParts, relId);
    default:
      return null;
  }
}
