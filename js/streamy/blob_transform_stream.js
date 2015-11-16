define(function(require) {
'use strict';

const { TransformStream } = require('streams');

/**
 * A stream that transforms a stream by chunking its input and returning Blobs.
 */
return function BlobTransformStream({ saveChunkSize, mimeType }) {
  var arrays = [];
  var size = 0;
  return new TransformStream({
    flush(enqueue, close) {
      if (arrays.length) {
        enqueue(new Blob(arrays, { type: mimeType }));
      }
      close();
    },
    transform(line, enqueue, done) {
      arrays.push(line);
      size += line.byteLength;
      if (size >= saveChunkSize) {
        console.warn(`Merging ${arrays.length} arrays into a blob...`);
        enqueue(new Blob(arrays, { type: mimeType }));
        console.warn(`done.`);
        arrays = [];
        size = 0;
      }
      done();
    }
  });
};
});
