define(function(require, exports) {
'use strict';

const { parseUI64: parseGmailMsgId, encodeInt: encodeA64 } = require('../a64');

const mimefuncs = require('mimefuncs');
const mailRep = require('../db/mail_rep');
const $mailchew = require('../bodies/mailchew');
const jsmime = require('jsmime');
const mimeStreams = require('mime-streams');

// parseImapDateTime and formatImapDateTime functions from node-imap;
// MIT licensed, (c) Brian White.

// ( ?\d|\d{2}) = day number; technically it's either "SP DIGIT" or "2DIGIT"
// but there's no harm in us accepting a single digit without whitespace;
// it's conceivable the caller might have trimmed whitespace.
//
// The timezone can, as unfortunately demonstrated by net-c.com/netc.fr, be
// omitted.  So we allow it to be optional and assume its value was zero if
// omitted.
var reDateTime =
      /^( ?\d|\d{2})-(.{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})(?: ([+-]\d{4}))?$/;
var HOUR_MILLIS = 60 * 60 * 1000;
var MINUTE_MILLIS = 60 * 1000;
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

/**
* Parses IMAP "date-time" instances into UTC timestamps whose quotes have
* already been stripped.
*
* http://tools.ietf.org/html/rfc3501#page-84
*
* date-day = 1*2DIGIT
* ; Day of month
* date-day-fixed = (SP DIGIT) / 2DIGIT
* ; Fixed-format version of date-day
* date-month = "Jan" / "Feb" / "Mar" / "Apr" / "May" / "Jun" /
* "Jul" / "Aug" / "Sep" / "Oct" / "Nov" / "Dec"
* date-year = 4DIGIT
* time = 2DIGIT ":" 2DIGIT ":" 2DIGIT
* ; Hours minutes seconds
* zone = ("+" / "-") 4DIGIT
* date-time = DQUOTE date-day-fixed "-" date-month "-" date-year
* SP time SP zone DQUOTE
*/
var parseImapDateTime = exports.parseImapDateTime = function(dstr) {
  var match = reDateTime.exec(dstr);
  if (!match) {
    throw new Error('Not a good IMAP date-time: ' + dstr);
  }
  var day = parseInt(match[1], 10),
      zeroMonth = MONTHS.indexOf(match[2]),
      year = parseInt(match[3], 10),
      hours = parseInt(match[4], 10),
      minutes = parseInt(match[5], 10),
      seconds = parseInt(match[6], 10),
      // figure the timestamp before the zone stuff. We don't
      timestamp = Date.UTC(year, zeroMonth, day, hours, minutes, seconds),
      // to reduce string garbage creation, we use one string. (we have to
      // play math games no matter what, anyways.)
      zoneDelta = match[7] ? parseInt(match[7], 10) : 0,
      zoneHourDelta = Math.floor(zoneDelta / 100),
      // (the negative sign sticks around through the mod operation)
      zoneMinuteDelta = zoneDelta % 100;

  // ex: GMT-0700 means 7 hours behind, so we need to add 7 hours, aka
  // subtract negative 7 hours.
  timestamp -= zoneHourDelta * HOUR_MILLIS + zoneMinuteDelta * MINUTE_MILLIS;

  return timestamp;
};

/**
 * Transform a browserbox representation of an item that has a value
 * (i.e. { value: foo }) into a pure value, recursively.
 *
 *   [{ value: 1 } ] -> [1]
 *   { value: 1 } -> 1
 *   undefined -> null
 */
var valuesOnly = exports.valuesOnly = function(item) {
  if (Array.isArray(item)) {
    return item.map(valuesOnly);
  } else if (item && typeof item === 'object') {
    if ('value' in item) {
      return item.value;
    } else {
      var result = {};
      for (var key in item) {
        result[key] = valuesOnly(item[key]);
      }
      return result;
    }
  } else if (item && typeof item === 'object') {
    return item;
  } else if (item !== undefined) {
    return item;
  } else {
    return null;
  }
};

/**
 * PartBuilder assists in populating the attachments/relatedParts/bodyReps of
 * the MessageInfo structure.
 *
 * As each part is added (because, with streaming, we don't have all parts),
 * we decide which ones are attachments, body parts, or parts to ignore.
 *
 * Usage:
 *   var builder = new PartBuilder(headers);
 *   builder.addPart(...);
 *   var { header, body } = builder.finalize();
 *
 * @param {MimeHeaderInfo} headers
 * @param {object} options
 */
function PartBuilder(headers) {
  this.rootHeaders = headers;

  this.attachments = [];
  this.relatedParts = [];
  this.bodyReps = [];

  this.unnamedPartCounter = 0;

  this.alternativePartNumbers = [];
}
exports.PartBuilder = PartBuilder;

PartBuilder.prototype = {

  /**
   * Return the header and body MailRep representation.
   */
  finalize: function() {
    // Since we only now know that we've seen all the parts, it's time to make
    // a decision for multipart/alternative parts: which body parts should we
    // keep, and which ones should we discard? We've generated bodyReps for
    // each compatible part, so we just need to remove the ones we don't want.
    this.alternativePartNumbers.forEach((altPart) => {
      var foundSuitableBody = false;
      for (var i = this.bodyReps.length - 1; i >= 0; i--) {
        var rep = this.bodyReps[i];
        // Is this rep a suitable body for this multipart/alternative part?
        // If so, the multipart/alternative part will be an ancestor of it.
        // We just want the first one that matches, since we already filtered
        // out unacceptable bodies.
        if (rep.part.indexOf(altPart + '.') === 0) {
          if (!foundSuitableBody) {
            foundSuitableBody = true;
          } else {
            this.bodyReps.splice(i, 1);
          }
        }
      }
    });

    return {
      attachments: this.attachments,
      relatedParts: this.relatedParts,
      bodyReps: this.bodyReps,
      rootHeaders: this.rootHeaders
    };
  },

  /**
   * Add one MimeHeaderInfo to the incoming message, returning information about
   * what kind of part we think this is (body/attachment/ignore).
   *
   * The return format is as follows:
   *
   * {
   *   type: 'ignore' OR 'attachment' OR 'related' OR 'body',
   *   rep: the MailRep representing this part,
   *   index: the index of the current part in attachments/relatedParts
   * }
   *
   * @param {string} partNum
   * @param {MimeHeaderInfo} headers
   * @return {object}
   */
  addNode: function(partNum, headers) {
    if (headers.parentContentType === 'message/rfc822') {
      return { type: 'ignore' };
    }
    if (headers.mediatype === 'multipart') {
      if (headers.subtype === 'alternative') {
        this.alternativePartNumbers.push(partNum);
      }
      return { type: 'ignore' };
    } else {
      // Ignore signatures.
      if ((headers.mediatype === 'application') &&
          (headers.subtype === 'pgp-signature' ||
           headers.subtype === 'pkcs7-signature')) {
        return { type: 'ignore' };
      }

      var rep;
      if (headers.disposition === 'attachment') {
        rep = this._makePart(partNum, headers);
        this.attachments.push(rep);
        return { type: 'attachment',
                 rep: rep,
                 index: this.attachments.length - 1 };
      }
      else if (headers.mediatype === 'image') {
        rep = this._makePart(partNum, headers);
        this.relatedParts.push(rep);
        return { type: 'related',
                 rep: rep,
                 index: this.relatedParts.length - 1 };
      }
      else if (headers.mediatype === 'text' &&
               (headers.subtype === 'plain' || headers.subtype === 'html')) {
        rep = this._makeBodyPart(partNum, headers);
        this.bodyReps.push(rep);
        return { type: 'body', rep: rep };
      } else {
        return { type: 'ignore' };
      }
    }
  },

  _makePart: function(partNum, headers) {
    return mailRep.makeAttachmentPart({
      relId: encodeA64(this.attachments.length),
      name: headers.filename || 'unnamed-' + (++this.unnamedPartCounter),
      contentId: headers.contentId,
      type: headers.contentType.toLowerCase(),
      part: partNum,
      encoding: headers.encoding,
      sizeEstimate: 0, // we do not know
      file: null,
      charset: headers.charset,
      textFormat: headers.format
    });
  },

  _makeBodyPart: function(partNum, headers) {
    return mailRep.makeBodyPart({
      type: headers.subtype,
      part: partNum,
      sizeEstimate: 0,
      amountDownloaded: 0,
      isDownloaded: false,
      contentBlob: null
    });
  }
};


/**
 * Convert the headers from a FETCH response to a MimeHeaderInfo object.
 */
function browserboxMessageToMimeHeaders(browserboxMessage) {
  var headers = new Map();
  for (var key in browserboxMessage) {
    // We test the key using a regex here because the key name isn't
    // normalized to a form we can rely on. The browserbox docs in
    // particular indicate that the full key name may be dependent on
    // the ordering of the fields as returned by the mail server (i.e.
    // the key name includes every header requested). One thing we can
    // rely on instead: grabbing the right key based upon just this
    // regex.
    if (/header\.fields/.test(key)) {
      // (the stuff in here runs exactly once; not multiple times!)
      var headerParser = new jsmime.MimeParser({
        startPart(jsmimePartNum, jsmimeHeaders) {
          headers = mimeStreams.MimeHeaderInfo.fromJSMime(jsmimeHeaders);
        }
      }, {
        bodyformat: 'decode', // Decode base64/quoted-printable for us.
        strformat: 'typedarray',
        onerror: (e) => {
          console.error('Browserbox->JSMIME Parser Error:', e, '\n', e.stack);
        }
      });
      headerParser.deliverData(browserboxMessage[key] + '\r\n');
      headerParser.deliverEOF();
      break;
    }
  }
  return headers;
}


/**
 * Encode a header value (with parameters) into a parameter header.
 *
 * encodeHeaderValueWithParams('text/plain', { charset: 'utf-8' })
 *   => 'text/plain; charset="utf-8"'
 */
function encodeHeaderValueWithParams(header, params) {
  var value = header;
  for (var key in params) {
    value += '; ' + key + '="' +
      mimefuncs.mimeWordEncode(params[key]) + '"';
  }
  return value;
}


/**
 * Return the estimated size of the encoded string.
 */
function estimatePartSizeInBytes(encoding, size) {
  switch (encoding.toLowerCase()) {
    case 'base64':
      // Base64 encodes 3 bytes in 4 characters with padding that always causes
      // the encoding to take 4 characters. The max encoded line length
      // (ignoring CRLF) is 76 bytes, with 72 bytes also fairly common. As such,
      // a 78=19*4+2 character line encodes 57=19*3 payload bytes and we can use
      // that as a rough estimate.
      return Math.floor(size * 57 / 78);
    case 'quoted-printable':
      // Quoted printable is hard to predict since only certain things need to
      // be encoded. It could be perfectly efficient if the source text has a
      // bunch of newlines built-in. Let's just provide an upper-bound of
      // perfectly efficient.
      return size;
    default:
      // No clue; upper bound.
      return size;
   }
}


/**
 * Convert a BODYSTRUCTURE response containing MIME metadata into a format
 * suitable for a MailRep (`{ header, body }`).
 */
exports.chewMessageStructure = function(msg, folderIds, flags, convId,
                                        maybeUmid, explicitMessageId) {
  var headers = browserboxMessageToMimeHeaders(msg);

  var partBuilder = new PartBuilder(headers);
  function chewStructureNode(snode, partNum, parentContentType) {
    var nodeHeaders = new mimeStreams.MimeHeaderInfo({
      'content-id': snode.id ? [snode.id] : null,
      'content-transfer-encoding': snode.encoding ? [snode.encoding] : null,
      'content-disposition': [encodeHeaderValueWithParams(
        snode.disposition, snode.dispositionParameters)],
      'content-type':
        [encodeHeaderValueWithParams(snode.type, snode.parameters)],
    }, { parentContentType });

    var { rep } = partBuilder.addNode(partNum, nodeHeaders);

    if (rep && snode.encoding && snode.size) {
      rep.sizeEstimate = estimatePartSizeInBytes(snode.encoding, snode.size);
    }
    if (rep) {
      rep._partInfo = {
        partId: snode.part,
        type: nodeHeaders.mediatype,
        subtype: nodeHeaders.subtype,
        params: snode.parameters,
        encoding: snode.encoding && snode.encoding.toLowerCase()
      };
    }

    if (snode.childNodes) {
      for (var i = 0; i < snode.childNodes.length; i++) {
        chewStructureNode(
          snode.childNodes[i], partNum + '.' + (i + 1), snode.type);
      }
    }
  }

  chewStructureNode(msg.bodystructure, '1', null);

  let { attachments, relatedParts, bodyReps } = partBuilder.finalize();

   let messageId;
   let umid = null;
   // non-gmail, umid-case.
   if (maybeUmid) {
     umid = maybeUmid;
     messageId = explicitMessageId;
   }
   // gmail case
   else {
     let gmailMsgId = parseGmailMsgId(msg['x-gm-msgid']);
     messageId = convId + '.' + gmailMsgId + '.' + msg.uid;
   }

  return mailRep.makeMessageInfo({
    id: messageId,
    // uniqueMessageId which provides server indirection for non-gmail sync
    umid,
    // The message-id header value
    guid: headers.guid,
    date: msg.internaldate ? parseImapDateTime(msg.internaldate) : headers.date,
    author: headers.author,
    to: headers.getAddressHeader('to', null),
    cc: headers.getAddressHeader('cc', null),
    bcc: headers.getAddressHeader('bcc', null),
    replyTo: headers.getAddressHeader('reply-to', null),
    flags: msg.flags,
    folderIds,
    hasAttachments: attachments.length > 0,
    subject: headers.getStringHeader('subject'),

    // we lazily fetch the snippet later on
    snippet: null,
    attachments,
    relatedParts,
    references: headers.references,
    bodyReps
  });
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
exports.updateMessageWithFetch = function(message, req, res) {
  var bodyRep = message.bodyReps[req.bodyRepIndex];

  // check if the request was unbounded or we got back less bytes then we
  // requested in which case the download of this bodyRep is complete.
  if (!req.bytes || res.bytesFetched < req.bytes[1]) {
    bodyRep.isDownloaded = true;

    // clear private space for maintaining parser state.
    bodyRep._partInfo = null;
  }

  if (!bodyRep.isDownloaded && res.buffer) {
    bodyRep._partInfo.pendingBuffer = new Blob([res.buffer]);
  }

  bodyRep.amountDownloaded += res.bytesFetched;

  var { contentBlob, snippet } = $mailchew.processMessageContent(
    res.text, bodyRep.type, bodyRep.isDownloaded, req.createSnippet);

  if (req.createSnippet) {
    message.snippet = snippet;
  }
  if (bodyRep.isDownloaded) {
    bodyRep.contentBlob = contentBlob;
  }
};

/**
 * Selects a desirable snippet body rep if the given header has no snippet.
 */
exports.selectSnippetBodyRep = function(message) {
  if (message.snippet) {
    return -1;
  }

  var bodyReps = message.bodyReps;
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
};
}); // end define
