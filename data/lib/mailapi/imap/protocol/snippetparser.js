define(
  [
    './textparser',
    'exports'
  ],
  function(
   $textparser,
   exports
  ) {

var TextParser = $textparser.TextParser;

function bufferAppend(buf1, buf2) {
  var newBuf = new Buffer(buf1.length + buf2.length);
  buf1.copy(newBuf, 0, 0);
  if (Buffer.isBuffer(buf2))
    buf2.copy(newBuf, buf1.length, 0);
  else if (Array.isArray(buf2)) {
    for (var i=buf1.length, len=buf2.length; i<len; i++)
      newBuf[i] = buf2[i];
  }

  return newBuf;
};

/**
 * Wrapper around the textparser, accumulates buffer content and returns it as
 * part of the .complete step.
 */
function SnippetParser(partDef) {
  $textparser.TextParser.apply(this, arguments);
}

SnippetParser.prototype = {
  parse: function(buffer) {
    if (!this._buffer) {
      this._buffer = buffer;
    } else {
      this._buffer = bufferAppend(this._buffer, buffer);
    }

    // do some magic parsing
    TextParser.prototype.parse.apply(this, arguments);
  },

  complete: function() {
    var content =
      TextParser.prototype.complete.apply(this, arguments);

    content.buffer = this._buffer;
    return content;
  }
};

exports.SnippetParser = SnippetParser;

});
