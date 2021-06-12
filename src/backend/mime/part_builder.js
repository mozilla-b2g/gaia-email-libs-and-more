define(function(require) {
'use strict';

const { encodeInt: encodeA64 } = require('shared/a64');

const mailRep = require('../db/mail_rep');

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

  this.nextRelId = 0;
  this.unnamedPartCounter = 0;

  this.alternativePartNumbers = [];
}
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
      var altCheck;
      if (altPart) {
        altCheck = new RegExp('^' + altPart + '.' );
      } else {
        // A multipart/alternative root may have a part that was undefined,
        // in which case our check should pass for all body parts.  Previously,
        // as part of the initial streaming branch we were generating our own
        // part numbers with the root being '1' which was probably sane, but
        // broke IMAP and arguably there are sanity benefits to using the same
        // names as the server.
        altCheck = /^/;
      }
      for (var i = this.bodyReps.length - 1; i >= 0; i--) {
        var rep = this.bodyReps[i];
        // Is this rep a suitable body for this multipart/alternative part?
        // If so, the multipart/alternative part will be an ancestor of it.
        // We just want the first one that matches, since we already filtered
        // out unacceptable bodies.
        if (altCheck.test(rep.part)) {
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
        rep = this._makePart(partNum, headers, 'a');
        this.attachments.push(rep);
        return {
          type: 'attachment',
          rep,
          index: this.attachments.length - 1
        };
      }
      else if (headers.mediatype === 'image') {
        rep = this._makePart(partNum, headers, 'r');
        this.relatedParts.push(rep);
        return {
          type: 'related',
          rep,
          index: this.relatedParts.length - 1
        };
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

  _makePart: function(partNum, headers, partType) {
    return mailRep.makeAttachmentPart({
      relId: partType + encodeA64(this.nextRelId++),
      name: headers.filename || 'unnamed-' + (++this.unnamedPartCounter),
      contentId: headers.contentId,
      type: headers.contentType.toLowerCase(),
      part: partNum,
      encoding: headers.encoding,
      sizeEstimate: 0, // we do not know
      downloadState: null,
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

return PartBuilder;
});
