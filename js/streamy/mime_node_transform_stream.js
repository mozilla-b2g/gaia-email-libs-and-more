define(function(require) {
'use strict';

const { ReadableStream, WritableStream } = require('streams');
const mimefuncs = require('mimefuncs');

const jsmime = require('jsmime');
const MimeHeaderInfo = require('../mime/mime_header_info');
const BlobTransformStream = require('./blob_transform_stream');

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
function MimeNodeTransformStream({ saveChunkSize, mimeType }) {
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
        bodyStream = new ReadableStream({
          start(controller) {
            partToStreamControllerMap.set(partNum, controller);
          }
        }).pipeThrough(new BlobTransformStream({ saveChunkSize, mimeType }));
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
      // TODO: Use some type of explicit logic.js-supported fault injection?
      if (MimeNodeTransformStream.TEST_ONLY_DIE_DURING_MIME_PROCESSING) {
        console.warn('*** Throwing exception in mime parsing for a test!');
        MimeNodeTransformStream.TEST_ONLY_DIE_DURING_MIME_PROCESSING = false;
        throw new Error('TEST_ONLY_DIE_DURING_MIME_PROCESSING');
      }
    }
  }, {
    bodyformat: 'decode', // Decode base64/quoted-printable for us.
    strformat: 'typedarray',
    onerror: (e) => {
      console.error('JSMIME Parser Error:', e, '\n', e.stack);
      out.error(e);
    }
  });

  // We receive data here...
  this.writable = new WritableStream({
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
  this.readable = new ReadableStream({
    start(controller) {
      out = controller;
    },
  });
}

MimeNodeTransformStream.TEST_ONLY_DIE_DURING_MIME_PROCESSING = false;

return MimeNodeTransformStream;
});
