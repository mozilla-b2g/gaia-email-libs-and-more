define(function(require) {
'use strict';

const streams = require('streams');
const util = require('util');

/**
 * A stream that transforms a byte-chunk stream into a stream that emits lines.
 * Partial lines (e.g. if the stream is closed) will not be returned.
 */
return function LineTransformStream() {
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
};
});
