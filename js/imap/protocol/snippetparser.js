define(['./textparser'], function($textparser) {
'use strict';

var TextParser = $textparser.TextParser;

function arrayAppend(array1, array2) {
  var tmp = new Uint8Array(array1.byteLength + array2.byteLength);
  tmp.set(array1, 0);
  tmp.set(array2, array1.byteLength);
  return tmp;
}

/**
 * Wrapper around the textparser, accumulates buffer content and returns it as
 * part of the .complete step.
 */
function SnippetParser(partDef) {
  TextParser.apply(this, arguments);
  this._array = null;
}

SnippetParser.prototype = {
  parse: function(u8array) {
    // XXX yuck.  right, so browserbox is currently providing us with a string.
    // this code has been assuming a Uint8Array.  So we'll convert to that.
    // Even though mailparser is going to end up converting it back after.  I'd
    // normalize this to expect strings but I think jsmime may want the
    // uint8array, so, yeah, ugh.
    if (typeof(u8array) === 'string') {
      u8array = (new TextEncoder()).encode(u8array);
    }
    if (!this._array) {
      this._array = u8array;
    } else {
      this._array = arrayAppend(this._array, u8array);
    }

    // do some magic parsing
    TextParser.prototype.parse.apply(this, arguments);
  },

  complete: function() {
    var content =
      TextParser.prototype.complete.apply(this, arguments);

    content.buffer = this._array.buffer;
    return content;
  }
};

  return {
    SnippetParser: SnippetParser
  };
});
