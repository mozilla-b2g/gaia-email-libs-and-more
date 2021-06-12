define(function(require) {
'use strict';

const jsmime = require('jsmime');
const dateMod = require('shared/date');
const util = require('shared/util');
const { generateMessageIdHeaderValue } = require('../bodies/mailchew');

/**
 * Given a message extract and normalize the references header into a list of
 * strings without arrows, etc.  If there is no references header but there is
 * an in-reply-to header, use that.
 *
 * Note that we currently require properly <> enclosed id's and ignore things
 * outside of them.
 *
 * @return {String[]}
 *   An array of references.  If there were no references, this will be an
 *   empty list.
 *
 * TODO: actually do the in-reply-to stuff; this has extra normalization sanity
 * checking required so not doing that right now.
 */
function extractReferences(referencesStr, messageId) {
  if (!referencesStr) {
    return [];
  }

  let idx = 0;
  let len = referencesStr.length;
  let references = [];

  while (idx < len) {
    idx = referencesStr.indexOf('<', idx);
    if (idx === -1) {
      break;
    }

    let closeArrow = referencesStr.indexOf('>', idx + 1);
    if (closeArrow === -1) {
      break;
    }

    // Okay, so now we have a <...> we can consume.
    let deArrowed = referencesStr.substring(idx + 1, closeArrow);
    // Don't let a message include itself in its references
    if (deArrowed !== messageId) {
      references.push(deArrowed);
    }

    idx = closeArrow + 1;
  }

  return references;
}

/**
 * MimeHeaderInfo transforms simple MIME header representations into parsed
 * header data.  MimeHeaderInfo also represents individual parts in a
 * multipart message.
 *
 * The reason we don't just use the header objects returned by JSMime is that
 * JSMime's StructuredHeaders expose different types of objects depending on
 * the header name requested, which leads to much confusion; additionally,
 * we need to construct a header representation from an IMAP BODYSTRUCTURE
 * response, which is more complex to translate into an equivalent JSMime
 * data structure.
 *
 * @param {object} rawHeaders
 *   An object of the form { headerName: [headerValueStrings] }.
 * @param {object} opts
 * @param {string} [opts.parentContentType]
 *   The contentType of the parent MIME node, if applicable. Optional.
 */
function MimeHeaderInfo(rawHeaders, opts) {
  var { parentContentType } = opts || {};

  this.rawHeaders = rawHeaders;

  this.parentContentType = parentContentType;
  this.contentType = this.getParameterHeader('content-type') ||
      'application/octet-stream';
  [this.mediatype, this.subtype] = this.contentType.split('/');
  this.contentId = util.stripArrows(this.getStringHeader('content-id'));
  this.filename = (this.getParameterHeader('content-type', 'name') ||
                   this.getParameterHeader('content-disposition', 'filename'));
  this.charset = this.getParameterHeader('content-type', 'charset');
  this.format = this.getParameterHeader('content-type', 'format');
  this.delsp = this.getParameterHeader('content-type', 'delsp');
  this.encoding = this.getStringHeader('content-transfer-encoding', 'binary');
  this.guid = util.stripArrows(this.getStringHeader('message-id'));

  // If we did not have a message-id header (as is the case with Outlook's
  // welcome message), generate a dummy value. Without a guid, we can't track
  // a message as part of a conversation. Thunderbird used to hash the message
  // or something, but with just the headers we risk hash collisions.
  if (!this.guid) {
    this.guid = generateMessageIdHeaderValue();
  }

  this.references =
    extractReferences(this.getStringHeader('references'), this.guid);

  this.author = this.getAddressHeader('from', [])[0] ||
    { name: 'Missing Author', address: 'missing@example.com' };

  this.disposition = this._computePracticalDisposition();
  this.date = this._computeDate();
}

/**
 * Convert a JSMime StructuredHeader representation into one we like.
 */
MimeHeaderInfo.fromJSMime = function(headers, opts = {}) {
  var rawHeaders = {};
  for (var key of headers._rawHeaders.keys()) {
    key = key.toLowerCase();
    rawHeaders[key] = headers.getRawHeader(key);
  }
  return new MimeHeaderInfo(rawHeaders, opts);
};

MimeHeaderInfo.prototype = {
  /**
   * Return a header as a simple string.
   */
  getStringHeader(headerName, defaultValue) {
    return (this.rawHeaders[headerName] || [])[0] || defaultValue;
  },

  /**
   * Parse a header that can accept parameters, and return either the main
   * value (e.g. "text/plain"), or if `paramName` is requested, the parameters
   * (e.g. "charset" -> "utf-8").
   *
   * getParameterHeader('content-type') => 'text/plain'
   * getParameterHeader('content-type', 'charset') => 'utf-8'
   */
  getParameterHeader(headerName, /* optional */ paramName) {
    var value = this.getStringHeader(headerName);
    if (value) {
      var params = jsmime.headerparser.parseParameterHeader(
        jsmime.headerparser.decodeRFC2047Words(value),
        /* doRFC2047: */ false, /* doRFC2231 */ true);

      if (paramName) {
        if (params.has(paramName)) {
          return params.get(paramName);
        }
      } else {
        return params.preSemi;
      }
    }
  },

  /**
   * Return an array of address objects representing the given header.
   * If no addresses are found, return defaultValue (which is otherwise null).
   */
  getAddressHeader(headerName, defaultValue) {
    var allResults =
      (this.rawHeaders[headerName] || []).reduce((results, header) => {
        return results.concat(
          jsmime.headerparser.parseAddressingHeader(
            header, /* doRFC2047: */ true).map((addr) => {
              if (addr.group) {
                return { group: addr.group, name: addr.name };
              } else {
                return { address: addr.email, name: addr.name };
              }
            }));
      }, []);
    if (allResults.length > 0) {
      return allResults;
    } else {
      return defaultValue || null;
    }
  },

  /**
   * We don't use the 'content-disposition' header verbatim; we have other
   * constraints that dictate whether or not we treat a MIME part as inline.
   */
  _computePracticalDisposition() {
    var disposition = this.getParameterHeader('content-disposition');

    // First, check whether an explict disposition exists.
    if (disposition) {
      // If it exists, keep it, except in the case of inline disposition
      // without a content-id. (Displaying text/* inline is not a problem for
      // us, but we need a content id for other embedded content. Currently only
      // images are supported, but that is enforced in a subsequent check.)
      if (disposition.toLowerCase() === 'inline' &&
          this.mediatype !== 'text' &&
          !this.contentId) {
        disposition = 'attachment';
      }
    }
    // If not, guess. TODO: Ensure 100% correctness in the future by fixing up
    // mis-guesses during sanitization as part of <https://bugzil.la/1024685>.
    else if (this.parentContentType === 'multipart/related' &&
             this.contentId &&
             this.mediatype === 'image') {
      // Inline image attachments that belong to a multipart/related may lack a
      // disposition but have a content-id.
      disposition = 'inline';
    } else if (this.filename || this.mediatype !== 'text') {
      disposition = 'attachment';
    } else {
      disposition = 'inline';
    }

    // Some clients want us to display things inline that we can't display
    // (historically and currently, PDF) or that our usage profile does not want
    // to automatically download (in the future, PDF, because they can get big).
    if (this.mediatype !== 'text' && this.mediatype !== 'image') {
      disposition = 'attachment';
    }

    return disposition;
  },

  /**
   * We don't use the 'date' header verbatim; we perform normalization.
   */
  _computeDate() {
    var now = dateMod.NOW();
    var dateString = this.getStringHeader('date');
    if (!dateString) {
      return now;
    }
    var dateTS = now;
    var dateHeader = jsmime.headerparser.parseDateHeader(dateString);
    // If we got a date, clamp it to now if it's trying to live in the future
    // or it's simply invalid.  Our rational for clamping is that we don't
    // want spammers to be able to permanently lodge their mails at the top of
    // the inbox or to otherwise upset our careful invariants.
    // If we don't have a date, then just use now as the date.  The rationale
    // for this is that we are already trusting the message's claimed
    // composition date, so it's not like this can be maliciously abused.
    if (dateHeader) {
      dateTS = dateHeader.getTime();
    }
    return Math.min(dateTS, now);
  },

};

return MimeHeaderInfo;
});
