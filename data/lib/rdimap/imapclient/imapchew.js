/**
 *
 **/

define(
  [
    'exports'
  ],
  function(
    exports
  ) {

/**
 * Process the headers and bodystructure of a message to build preliminary state
 * and determine what body parts to fetch.  The list of body parts will be used
 * to issue another fetch request, and those results will be passed to
 * `chewBodyParts`.
 *
 * For now, our stop-gap heuristics for content bodies are:
 * - pick text/plain in multipart/alternative
 * - recurse into other multipart types looking for an alterntive that has
 *    text.
 * - do not recurse into message/rfc822
 * - ignore/fail-out messages that lack a text part, skipping to the next
 *    task.  (This should not happen once we support HTML, as there are cases
 *    where there are attachments without any body part.)
 * - Append text body parts together; there is no benefit in separating a
 *    mailing list footer from its content.
 *
 * For attachments, our heuristics are:
 * - only like them if they have filenames.  We will find this as "name" on
 *    the "content-type" or "filename" on the "content-disposition", quite
 *    possibly on both even.  For imap.js, "name" shows up in the "params"
 *    dict, and filename shows up in the "disposition" dict.
 * - ignore crypto signatures, even though they are named.  S/MIME gives us
 *    "smime.p7s" as an application/pkcs7-signature under a multipart/signed
 *    (that the server tells us is "signed").  PGP in MIME mode gives us
 *    application/pgp-signature "signature.asc" under a multipart/signed.
 *
 * The next step in the plan is to get an HTML sanitizer exposed so we can
 *  support text/html.  That will also imply grabbing multipart/related
 *  attachments.
 *
 * @typedef[ChewRep @dict[
 *   @key[msg ImapJsMsg]
 *   @key[bodyParts @listof[ImapJsPart]]
 *   @key[attachments @listof[AttachmentInfo]]
 *   @key[header HeaderInfo]
 *   @key[bodyInfo BodyInfo]
 * ]]
 * @return[ChewRep]
 */
exports.chewHeaderAndBodyStructure = function chewStructure(msg) {
  // imap.js builds a bodystructure tree using lists.  All nodes get wrapped
  //  in a list so they are element zero.  Children (which get wrapped in
  //  their own list) follow.
  //
  // Examples:
  //   text/plain =>
  //     [{text/plain}]
  //   multipart/alternative with plaintext and HTML =>
  //     [{alternative} [{text/plain}] [{text/html}]]
  //   multipart/mixed text w/attachment =>
  //     [{mixed} [{text/plain}] [{application/pdf}]]
  var attachments = [], bodyParts = [];

  /**
   * Sizes are the size of the encoded string, not the decoded value.
   */
  function estimatePartSizeInBytes(partInfo) {
    var encoding = partInfo.encoding;
    // Base64 encodes 3 bytes in 4 characters with padding that always
    // causes the encoding to take 4 characters.  The max encoded line length
    // (ignoring CRLF) is 76 bytes, with 72 bytes also fairly common.
    // As such, a 78=19*4+2 character line encodes 57=19*3 payload bytes and
    // we can use that as a rough estimate.
    if (encoding === 'base64') {
      return Math.floor(partInfo.size * 57 / 78);
    }
    // Quoted printable is hard to predict since only certain things need
    // to be encoded.  It could be perfectly efficient if the source text
    // has a bunch of newlines built-in.
    else if (encoding === 'quoted-printable') {
      // Let's just provide an upper-bound of perfectly efficient.
      return partInfo.size;
    }
    // No clue; upper bound.
    return partInfo.size;
  }

  function chewStruct(branch) {
    var partInfo = branch[0], i,
        filename;

    // - Detect named parts; they could be attachments
    if (partInfo.params && partInfo.params.name)
      filename = partInfo.params.name;
    else if (partInfo.disposition && partInfo.disposition.filename)
      filename = partInfo.disposition.filename;
    else
      filename = null;

    // XXX check explicit content-disposition which is dependent on an
    //  imap.js fix; we want to do inline display of inline things
    //  that we actually can display/want to display.

    // - But we don't care if they are signatures...
    if ((type === 'application') &&
        (subtype === 'pgp-signature' || subtype === 'pkcs7-signature'))
      return;

    // - Attachments have names and don't have id's for multipart/related
    if (filename && !partInfo.id) {
      attachments.push({
        name: filename,
        part: partInfo.partID,
        sizeEstimate: estimatePartSizeInBytes(partInfo),
      });
      return;
    }
    // XXX once we support html we need to save off the related bits.

    // - We must be an inline part or structure
    switch (partInfo.type) {
      // - content
      case 'text':
        if (partInfo.subtype === 'plain') {
          bodyParts.push(partInfo);
        }
        // (ignore html)
        break;

      // - multipart that we should recurse into
      case 'alternative':
      case 'mixed':
      case 'signed':
        for (i = 1; i < branch.length; i++) {
          chewStruct(branch[i]);
        }
        break;
    }
    // - ignored
  }
  chewStruct(msg.structure);

  return {
    msg: msg,
    bodyParts: bodyParts,
    attachments: attachments,
    header: null,
    bodyInfo: null,
  };
};

// What do we think the post-snappy compression overhead of the structured clone
// persistence rep will be for various things?  These are total guesses right
// now.  Keep in mind we do want the pre-compression size of the data in all
// cases and we just hope it will compress a bit.  For the attributes we are
// including the attribute name as well as any fixed-overhead for its payload,
// especially numbers which may or may not be zig-zag encoded/etc.
const OBJ_OVERHEAD_EST = 2, STR_ATTR_OVERHEAD_EST = 5,
      NUM_ATTR_OVERHEAD_EST = 10, LIST_ATTR_OVERHEAD_EST = 4,
      NULL_ATTR_OVERHEAD_EST = 2;

/**
 * Call once the body parts requested by `chewHeaderAndBodyStructure` have been
 * fetched in order to finish processing of the message to produce the header
 * and body data-structures for the message.
 *
 * @args[
 *   @param[rep ChewRep]
 *   @param[bodyPartContents @listof[String]]{
 *     The fetched body parts matching the list of requested parts in
 *     `rep.bodyParts`.
 *   }
 * ]
 * @return[success Boolean]{
 *   True if we were able to process the message and have updated `rep.header`
 *   and `rep.bodyInfo` with populated objects.
 * }
 */
exports.chewBodyParts = function chewBodyParts(rep, bodyPartContents) {
  // XXX we really want to perform quoting analysis, yadda yadda.
  var fullBody = bodyPartContents.join('\n'),
      // Up to 80 characters of snippet, normalizing whitespace.
      snippet = fullBody.substring(0, 80).replace(/[\r\n\t ]+/g, ' ');

  rep.header = {
    id: rep.msg.id,
    author: rep.msg.msg.from,
    date: rep.msg.date,
    flags: rep.msg.flags,
    hasAttachments: rep.attachments.length > 0,
    subject: rep.msg.msg.subject,
    snippet: snippet,
  };

  // crappy size estimates where we assume the world is ASCII and so a UTF-8
  // encoding will take exactly 1 byte per character.
  var sizeEst = OBJ_OVERHEAD_EST + NUM_ATTR_OVERHEAD_EST +
                  4 * MAYBE_NULL_OVERHEAD_EST;
  function sizifyAddrs(addrs) {
    sizeEst += LIST_ATTR_OVERHEAD_EST;
    for (var i = 0; i < addrs.length; i++) {
      var addrPair = addrs[i];
      sizeEst += OBJ_OVERHEAD_EST + 2 * STR_ATTR_OVERHEAD_EST +
                   addrPair.name.length + addrPair.address.length;
    }
    return addrs;
  }
  function sizifyAttachments(atts) {
    sizeEst += LIST_ATTR_OVERHEAD_EST;
    for (var i = 0; i < atts.length; i++) {
      var att = atts[i];
      sizeEst += OBJ_OVERHEAD_EST + 2 * STR_ATTR_OVERHEAD_EST +
                   att.filename.length + att.mimetype.length +
                   NUM_ATTR_OVERHEAD_EST;
    }
    return atts;
  }
  function sizifyStr(str) {
    sizeEst += STR_ATTR_OVERHEAD_EST + str.length;
    return str;
  }
  rep.bodyInfo = {
    size: sizeEst,
    to: ('to' in rep.msg.msg) ? sizifyAddrs(rep.msg.msg.to) : null,
    cc: ('cc' in rep.msg.msg) ? sizifyAddrs(rep.msg.msg.cc) : null,
    bcc: ('bcc' in rep.msg.msg) ? sizifyAddrs(rep.msg.msg.bcc) : null,
    replyTo: ('reply-to' in rep.msg.parsedHeaders) ?
               sizifyStr(rep.msg.parsedHeaders['reply-to']) : null,
    attachments: sizifyAttachments(rep.attachments),
    bodyText: sizifyStr(fullBody),
  };

  return true;
};

}); // end define
