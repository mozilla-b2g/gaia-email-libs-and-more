define(function() {
'use strict';

return function readAllChunks(readableStream) {
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
};
});
