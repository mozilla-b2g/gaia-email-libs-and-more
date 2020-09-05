import { TextParser } from './textparser';

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
export function SnippetParser(/*partDef*/) {
  TextParser.apply(this, arguments);
  this._array = null;
}
SnippetParser.prototype = {
  parse(u8array) {
    if (!this._array) {
      this._array = u8array;
    } else {
      this._array = arrayAppend(this._array, u8array);
    }

    // do some magic parsing
    TextParser.prototype.parse.apply(this, arguments);
  },

  complete() {
    var content =
      TextParser.prototype.complete.apply(this, arguments);

    content.buffer = this._array.buffer;
    return content;
  }
};
