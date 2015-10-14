define(function(require, exports) {

var syncbase = require('syncbase');
var mimefuncs = require('mimefuncs');
var streams = require('streams');
var util = require('util');
var jsmime = require('jsmime');
var dateMod = require('date');
var co = require('co');
var logic = require('logic');

/**
 * The classes in this file wrap common e-mail protocol-related behavior into
 * streams. Of particular note:
 *
 * - SocketStream, a class that builds a stream out of a mozTCPSocket;
 *
 * - MimeHeaderInfo, a class that normalizes MIME headers from jsmime and others
 *   into a format we can easily consume;
 *
 * - MimeNodeTransformStream, a transform stream that consumes data and spits
 *   out parsed MIME nodes;
 *
 * - readAttachmentStreamWithChunkFlushing, a function that consumes a stream
 *   of attachment data, shoves it into blobs, and flushes chunks to disk.
 */


/**
 * A Stream built from a mozTCPSocket. Data arrives in chunks to the readable
 * side of the stream; to send data, write to the writable side.
 */
exports.SocketStream = function(socket) {
  socket = util.makeEventTarget(socket);

  function maybeCloseSocket() {
    if (socket.readyState !== 'closing' && socket.readyState !== 'closed') {
      socket.close();
    }
  }

  var out;

  this.readable = new streams.ReadableStream({
    start: function(c) {
      out = c;
      socket.addEventListener('data', (evt) => {
        c.enqueue(new Uint8Array(evt.data))
      });
      socket.addEventListener('close', () => {
        try {
          c.close();
        } catch(e) {
          // The stream has already been closed.
        }
      });
      socket.addEventListener('error', (evt) => c.error(evt.data || evt));
    },
    cancel: function() {
      maybeCloseSocket();
    }
  });

  this.writable = new streams.WritableStream({
    start: function(error) {
      socket.addEventListener('error', (evt) => error(evt.data || evt));
    },
    write: function(chunk) {
      socket.send(chunk);
      // We don't know when send completes, so this is synchronous.
    },
    close: function() {
      maybeCloseSocket();
    }
  })
}

/**
 * A stream that transforms a byte-chunk stream into a stream that emits lines.
 * Partial lines (e.g. if the stream is closed) will not be returned.
 */
exports.LineTransformStream = function() {
  var c; // the readable controller

  var CR = 13;
  var LF = 10;

  // Partial lines will be stored here (null if there is no partial line).
  var partialLineBuffer = null;

  // Data comes in as chunks of bytes, so we buffer it...
  this.writable = new streams.WritableStream({
    write(chunk) {
      if (partialLineBuffer) {
        chunk = util.concatBuffers(partialLineBuffer, chunk);
        partialLineBuffer = null;
      }
      var lastEndIndex = 0;
      for (var i = 0; i < chunk.length - 1; i++) {
        if (chunk[i] === CR && chunk[i + 1] === LF) {
          c.enqueue(chunk.subarray(lastEndIndex, i + 2));
          lastEndIndex = i + 2;
          i++; // Advance to the LF.
        }
      }
      // If there was any data left over, store it in the buffer.
      if (lastEndIndex < chunk.length) {
        partialLineBuffer = chunk.subarray(lastEndIndex);
      }
    },

    close() {
      console.log('CLOSE writable linestream');
      c.close();
    }
  });

  // Data goes out as lines from here.
  this.readable = new streams.ReadableStream({
    start(controller) {
      c = controller;
    }
  });
}


/**
 * MimeHeaderInfo transforms simple MIME header representations into parsed
 * header data. Not to be confused with HeaderInfo, which describes e-mail
 * message headers; MimeHeaderInfo also represents individual parts in a
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

  var refs = this.getStringHeader('references');
  this.references = refs ? util.stripArrows(refs.split(/\s+/)) : null;

  this.author = this.getAddressHeader('from', [])[0] ||
    { name: 'Missing Author', address: 'missing@example.com' };

  this.disposition = this._computePracticalDisposition();
  this.date = this._computeDate();
}

exports.MimeHeaderInfo = MimeHeaderInfo;

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
}

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

exports.TEST_ONLY_DIE_DURING_MIME_PROCESSING = false;

/**
 * MimeNodeTransformStream: A stream that receives lines of MIME data, and emits
 * an object for each MimeNode it encounters.
 *
 * Each time we parse a MIME header, we emit an object with the following:
 *
 *   var { partNum, headers, bodyStream } = yield stream.read();
 *
 * - `headers` is a MimeHeaderInfo structure for the given part.
 *
 * - `bodyStream` is a stream of partial blobs for this node.
 */
exports.MimeNodeTransformStream = function() {
  var partToStreamControllerMap = new Map();
  var partToContentTypeMap = new Map();

  var out;
  var parser = new jsmime.MimeParser({
    endMessage() {
      out.close();
    },
    startPart(jsmimePartNum, jsmimeHeaders) {
      var partNum = (jsmimePartNum === '' ? '1' : '1.' + jsmimePartNum);
      var headers = MimeHeaderInfo.fromJSMime(jsmimeHeaders, {
        parentContentType:
          partNum.indexOf('.') !== -1
            ? partToContentTypeMap.get(
                partNum.slice(0, partNum.lastIndexOf('.')))
            : null
      });

      partToContentTypeMap.set(partNum, headers.contentType);

      var bodyStream = null;
      if (headers.mediatype !== 'multipart') {
        bodyStream = new streams.ReadableStream({
          start(controller) {
            partToStreamControllerMap.set(partNum, controller);
          }
        }).pipeThrough(new exports.BlobTransformStream());
      }

      out.enqueue({
        partNum: partNum,
        headers: headers,
        bodyStream: bodyStream
      });
    },
    endPart(jsmimePartNum) {
      var partNum = (jsmimePartNum === '' ? '1' : '1.' + jsmimePartNum);
      var partOut = partToStreamControllerMap.get(partNum);
      if (partOut) {
        partOut.close();
      }
    },
    deliverPartData(jsmimePartNum, data) {
      var partNum = (jsmimePartNum === '' ? '1' : '1.' + jsmimePartNum);
      var partOut = partToStreamControllerMap.get(partNum);
      if (partOut) {
        partOut.enqueue(data);
      }
      if (exports.TEST_ONLY_DIE_DURING_MIME_PROCESSING) {
        console.warn('*** Throwing exception in mime parsing for a test!');
        exports.TEST_ONLY_DIE_DURING_MIME_PROCESSING = false;
        throw new Error('TEST_ONLY_DIE_DURING_MIME_PROCESSING');
      }
    }
  }, {
    bodyformat: 'decode', // Decode base64/quoted-printable for us.
    strformat: 'typedarray',
    onerror: (e) => {
      console.error('JSMIME Parser Error:', e, '\n', e.stack)
      out.error(e);
    }
  });

  // We receive data here...
  this.writable = new streams.WritableStream({
    write(chunk) {
      parser.deliverData(mimefuncs.fromTypedArray(chunk));
    },
    abort(e) {
      // On connection death or a negative response, we abort.
      out.error(e);
    },
    close() {
      parser.deliverEOF();
    }
  });

  // We emit data here.
  this.readable = new streams.ReadableStream({
    start(controller) {
      out = controller;
    },
  });
}

/**
 * A simple transform stream that counts the bytes passing through it,
 * exposing the count as `totalBytesRead`.
 */
exports.ByteCounterTransformStream = function() {
  var self = this;
  var ts = new streams.TransformStream({
    transform(chunk, enqueue, done) {
      self.totalBytesRead += chunk.byteLength;
      enqueue(chunk);
      done();
    }
  });

  this.writable = ts.writable;
  this.readable = ts.readable;

  /** @member {number} */
  this.totalBytesRead = 0;
}

/**
 * A stream that transforms a stream by chunking its input and returning Blobs.
 */
exports.BlobTransformStream = function() {
  var arrays = [];
  var size = 0;
  return new streams.TransformStream({
    flush(enqueue, close) {
      if (arrays.length) {
        enqueue(new Blob(arrays));
      }
      close();
    },
    transform(line, enqueue, done) {
      arrays.push(line);
      size += line.byteLength;
      if (size >= syncbase.BYTES_PER_BLOB_CHUNK) {
        console.warn(`Merging ${arrays.length} arrays into a blob...`);
        enqueue(new Blob(arrays));
        console.warn(`done.`);
        arrays = [];
        size = 0;
      }
      done();
    }
  });
}

exports.readAllChunks = function(readableStream) {
  var reader = readableStream.getReader();
  var chunks = [];

  return pump();

  function pump() {
    return reader.read().then(({ value, done }) => {
      if (done) {
        return chunks;
      }

      chunks.push(value);
      return pump();
    });
  }
}


exports.readAttachmentStreamWithChunkFlushing =
co.wrap(function*(contentType, bodyStream, flushFileFn) {
  var attachmentReader = bodyStream.getReader();
  var file = { parts: [] };
  for(;;) {
    var { value: blob, done } = yield attachmentReader.read();
    if (!done) {
      file.parts.push(blob);
      console.warn(`Flushing blob chunk... (${file.parts.length} parts)`);
      if (flushFileFn) {
        file = yield flushFileFn(file);
      }
      console.warn(`Flush finished.`);
      // Blob.close() is slated to be a thing someday,
      // but it is not in Gecko yet. <http://www.w3.org/TR/FileAPI/>
      if (blob.close) {
        blob.close();
      }
    } else {
      console.warn(`All blobs fetched.` +
                   `Concatenating into a ${contentType} super-blob...`);
      file = new Blob(file.parts, { type: contentType });
      console.warn(`Done concatenating.`);
      logic(logic.scope('Attachments'), 'attachment-blob', {
        blob: file,
        type: file.type
      });

      if (flushFileFn) {
        file = yield flushFileFn(file);
      }

      return file;
    }
  }
});



}); // end define
