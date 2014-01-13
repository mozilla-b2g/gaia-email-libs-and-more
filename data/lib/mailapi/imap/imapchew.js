/**
 *
 **/

define(
  [
    'mimelib',
    'mailapi/db/mail_rep',
    '../mailchew',
    'exports'
  ],
  function(
    $mimelib,
    mailRep,
    $mailchew,
    exports
  ) {

function parseRfc2231CharsetEncoding(s) {
  // charset'lang'url-encoded-ish
  var match = /^([^']*)'([^']*)'(.+)$/.exec(s);
  if (match) {
    // we can convert the dumb encoding into quoted printable.
    return $mimelib.parseMimeWords(
      '=?' + (match[1] || 'us-ascii') + '?Q?' +
        match[3].replace(/%/g, '=') + '?=');
  }
  return null;
}

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
 *   @key[bodyReps @listof[ImapJsPart]]
 *   @key[attachments @listof[AttachmentInfo]]
 *   @key[relatedParts @listof[RelatedPartInfo]]
 * ]]
 * @return[ChewRep]
 */
function chewStructure(msg) {
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
  var attachments = [], bodyReps = [], unnamedPartCounter = 0,
      relatedParts = [];

  /**
   * Sizes are the size of the encoded string, not the decoded value.
   */
  function estimatePartSizeInBytes(partInfo) {
    var encoding = partInfo.encoding.toLowerCase();
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

  function chewLeaf(branch) {
    var partInfo = branch[0], i,
        filename, disposition;

    // - Detect named parts; they could be attachments
    // filename via content-type 'name' parameter
    if (partInfo.params && partInfo.params.name) {
      filename = $mimelib.parseMimeWords(partInfo.params.name);
    }
    // filename via content-type 'name' with charset/lang info
    else if (partInfo.params && partInfo.params['name*']) {
      filename = parseRfc2231CharsetEncoding(
                   partInfo.params['name*']);
    }
    // rfc 2231 stuff:
    // filename via content-disposition filename without charset/lang info
    else if (partInfo.disposition && partInfo.disposition.params &&
             partInfo.disposition.params.filename) {
      filename = $mimelib.parseMimeWords(partInfo.disposition.params.filename);
    }
    // filename via content-disposition filename with charset/lang info
    else if (partInfo.disposition && partInfo.disposition.params &&
             partInfo.disposition.params['filename*']) {
      filename = parseRfc2231CharsetEncoding(
                   partInfo.disposition.params['filename*']);
    }
    else {
      filename = null;
    }

    // - Start from explicit disposition, make attachment if non-displayable
    if (partInfo.disposition)
      disposition = partInfo.disposition.type.toLowerCase();
    // UNTUNED-HEURISTIC (need test cases)
    // Parts with content ID's explicitly want to be referenced by the message
    // and so are inline.  (Although we might do well to check if they actually
    // are referenced.  This heuristic could be very wrong.)
    else if (partInfo.id)
      disposition = 'inline';
    else if (filename || partInfo.type !== 'text')
      disposition = 'attachment';
    else
      disposition = 'inline';

    // Some clients want us to display things inline that we simply can't
    // display (historically and currently, PDF) or that our usage profile
    // does not want to automatically download (in the future, PDF, because
    // they can get big.)
    if (partInfo.type !== 'text' &&
        partInfo.type !== 'image')
      disposition = 'attachment';

    // - But we don't care if they are signatures...
    if ((partInfo.type === 'application') &&
        (partInfo.subtype === 'pgp-signature' ||
         partInfo.subtype === 'pkcs7-signature'))
      return true;

    function stripArrows(s) {
      if (s[0] === '<')
        return s.slice(1, -1);
      return s;
    }

    function makePart(partInfo, filename) {

      return mailRep.makeAttachmentPart({
        name: filename || 'unnamed-' + (++unnamedPartCounter),
        contentId: partInfo.id ? stripArrows(partInfo.id) : null,
        type: (partInfo.type + '/' + partInfo.subtype).toLowerCase(),
        part: partInfo.partID,
        encoding: partInfo.encoding && partInfo.encoding.toLowerCase(),
        sizeEstimate: estimatePartSizeInBytes(partInfo),
        file: null,
        /*
        charset: (partInfo.params && partInfo.params.charset &&
                  partInfo.params.charset.toLowerCase()) || undefined,
        textFormat: (partInfo.params && partInfo.params.format &&
                     partInfo.params.format.toLowerCase()) || undefined
         */
      });
    }

    function makeTextPart(partInfo) {
      return mailRep.makeBodyPart({
        type: partInfo.subtype,
        part: partInfo.partID,
        sizeEstimate: partInfo.size,
        amountDownloaded: 0,
        // its important to know that sizeEstimate and amountDownloaded
        // do _not_ determine if the bodyRep is fully downloaded; the
        // estimated amount is not reliable
        // Zero-byte bodies are assumed to be accurate and we treat the file
        // as already downloaded.
        isDownloaded: partInfo.size === 0,
        // full internal IMAP representation
        // it would also be entirely appropriate to move
        // the information on the bodyRep directly?
        _partInfo: partInfo.size ? partInfo : null,
        content: ''
      });
    }

    if (disposition === 'attachment') {
      attachments.push(makePart(partInfo, filename));
      return true;
    }

    // - We must be an inline part or structure
    switch (partInfo.type) {
      // - related image
      case 'image':
        relatedParts.push(makePart(partInfo, filename));
        return true;
        break;
      // - content
      case 'text':
        if (partInfo.subtype === 'plain' ||
            partInfo.subtype === 'html') {
          bodyReps.push(makeTextPart(partInfo));
          return true;
        }
        break;
    }
    return false;
  }

  function chewMultipart(branch) {
    var partInfo = branch[0], i;

    // - We must be an inline part or structure
    // I have no idea why the multipart is the 'type' rather than the subtype?
    switch (partInfo.subtype) {
      // - for alternative, scan from the back to find the first part we like
      // XXX I believe in Thunderbird we observed some ridiculous misuse of
      // alternative that we'll probably want to handle.
      case 'alternative':
        for (i = branch.length - 1; i >= 1; i--) {
          var subPartInfo = branch[i][0];

          switch(subPartInfo.type) {
            case 'text':
              // fall out for subtype checking
              break;
            case 'multipart':
              // this is probably HTML with attachments, let's give it a try
              if (chewMultipart(branch[i]))
                return true;
              break;
            default:
              // no good, keep going
              continue;
          }

          switch (subPartInfo.subtype) {
            case 'html':
            case 'plain':
              // (returns true if successfully handled)
              if (chewLeaf(branch[i]))
                return true;
          }
        }
        // (If we are here, we failed to find a valid choice.)
        return false;
      // - multipart that we should recurse into
      case 'mixed':
      case 'signed':
      case 'related':
        for (i = 1; i < branch.length; i++) {
          if (branch[i].length > 1)
            chewMultipart(branch[i]);
          else
            chewLeaf(branch[i]);
        }
        return true;

      default:
        console.warn('Ignoring multipart type:', partInfo.subtype);
        return false;
    }
  }

  if (msg.structure.length > 1)
    chewMultipart(msg.structure);
  else
    chewLeaf(msg.structure);

  return {
    bodyReps: bodyReps,
    attachments: attachments,
    relatedParts: relatedParts,
  };
};

exports.chewHeaderAndBodyStructure =
  function(msg, folderId, newMsgId) {
  // begin by splitting up the raw imap message
  var parts = chewStructure(msg);
  var rep = {};

  rep.header = mailRep.makeHeaderInfo({
    // the FolderStorage issued id for this message (which differs from the
    // IMAP-server-issued UID so we can do speculative offline operations like
    // moves).
    id: newMsgId,
    srvid: msg.id,
    // The sufficiently unique id is a concatenation of the UID onto the
    // folder id.
    suid: folderId + '/' + newMsgId,
    // The message-id header value; as GUID as get for now; on gmail we can
    // use their unique value, or if we could convince dovecot to tell us, etc.
    guid: msg.msg.meta.messageId,
    // mailparser models from as an array; we do not.
    author: msg.msg.from && msg.msg.from[0] ||
              // we require a sender e-mail; let's choose an illegal default as
              // a stopgap so we don't die.
              { address: 'missing-address@example.com' },
    to: ('to' in msg.msg) ? msg.msg.to : null,
    cc: ('cc' in msg.msg) ? msg.msg.cc : null,
    bcc: ('bcc' in msg.msg) ? msg.msg.bcc : null,

    replyTo: ('reply-to' in msg.msg.parsedHeaders) ?
               msg.msg.parsedHeaders['reply-to'] : null,

    date: msg.date,
    flags: msg.flags,
    hasAttachments: parts.attachments.length > 0,
    subject: msg.msg.subject || null,

    // we lazily fetch the snippet later on
    snippet: null
  });


  rep.bodyInfo = mailRep.makeBodyInfo({
    date: msg.date,
    size: 0,
    attachments: parts.attachments,
    relatedParts: parts.relatedParts,
    references: msg.msg.references,
    bodyReps: parts.bodyReps
  });

  return rep;
};

/**
 * Fill a given body rep with the content from fetching
 * part or the entire body of the message...
 *
 *    var body = ...;
 *    var header = ...;
 *    var content = (some fetched content)..
 *
 *    $imapchew.updateMessageWithFetch(
 *      header,
 *      bodyInfo,
 *      {
 *        bodyRepIndex: 0,
 *        text: '',
 *        buffer: Uint8Array|Null,
 *        bytesFetched: n,
 *        bytesRequested: n
 *      }
 *    );
 *
 *    // what just happend?
 *    // 1. the body.bodyReps[n].content is now the value of content.
 *    //
 *    // 2. we update .amountDownloaded with the second argument
 *    //    (number of bytes downloaded).
 *    //
 *    // 3. if snippet has not bee set on the header we create the snippet
 *    //    and set its value.
 *
 */
exports.updateMessageWithFetch = function(header, body, req, res, _LOG) {
  var bodyRep = body.bodyReps[req.bodyRepIndex];

  // check if the request was unbounded or we got back less bytes then we
  // requested in which case the download of this bodyRep is complete.
  if (!req.bytes || res.bytesFetched < req.bytes[1]) {
    bodyRep.isDownloaded = true;

    // clear private space for maintaining parser state.
    bodyRep._partInfo = null;
  }

  if (!bodyRep.isDownloaded && res.buffer) {
    bodyRep._partInfo.pendingBuffer = res.buffer;
  }

  bodyRep.amountDownloaded += res.bytesFetched;

  var data = $mailchew.processMessageContent(
    res.text, bodyRep.type, bodyRep.isDownloaded, req.createSnippet, _LOG
  );

  if (req.createSnippet) {
    header.snippet = data.snippet;
  }
  if (bodyRep.isDownloaded)
    bodyRep.content = data.content;
};

/**
 * Selects a desirable snippet body rep if the given header has no snippet.
 */
exports.selectSnippetBodyRep = function(header, body) {
  if (header.snippet)
    return -1;

  var bodyReps = body.bodyReps;
  var len = bodyReps.length;

  for (var i = 0; i < len; i++) {
    if (exports.canBodyRepFillSnippet(bodyReps[i])) {
      return i;
    }
  }

  return -1;
};

/**
 * Determines if a given body rep can be converted into a snippet. Useful for
 * determining which body rep to use when downloading partial bodies.
 *
 *
 *    var bodyInfo;
 *    $imapchew.canBodyRepFillSnippet(bodyInfo.bodyReps[0]) // true/false
 *
 */
exports.canBodyRepFillSnippet = function(bodyRep) {
  return (
    bodyRep &&
    bodyRep.type === 'plain' ||
    bodyRep.type === 'html'
  );
};


/**
 * Calculates and returns the correct estimate for the number of
 * bytes to download before we can display the body. For IMAP, that
 * includes the bodyReps and related parts. (POP3 is different.)
 */
exports.calculateBytesToDownloadForImapBodyDisplay = function(body) {
  var bytesLeft = 0;
  body.bodyReps.forEach(function(rep) {
    if (!rep.isDownloaded) {
      bytesLeft += rep.sizeEstimate - rep.amountDownloaded;
    }
  });
  body.relatedParts.forEach(function(part) {
    if (!part.file) {
      bytesLeft += part.sizeEstimate;
    }
  });
  return bytesLeft;
}



}); // end define
