define(function(require) {
'use strict';

const streams = require('streams');

/**
 * A simple transform stream that counts the bytes passing through it,
 * exposing the count as `totalBytesRead`.
 */
return function ByteCounterTransformStream() {
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
};
});
