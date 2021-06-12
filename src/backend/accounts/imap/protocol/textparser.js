import MimeParser from 'mimeparser';
import mimefuncs from 'mimefuncs';

/**
 * Simple wrapper around mimeparser hacks allows us to reuse data from the
 * BODYSTRUCT request that contained the mime type, etc....
 *
 *    var parser = $textparser.TextParser(
 *      bodyInfo.bodyReps[n]
 *    );
 *
 *    // msg is some stream thing from fetcher
 *
 *    msg.on('data', parser.parse.bind(parser));
 *    msg.on('end', function() {
 *      var content = parser.complete();
 *    });
 *
 * XXX convert this implementation to use jsmime like was done in other parts
 * of :mcav's streamification work.  In particular, we want this because it
 * avoids an additional conversion of the "buffer" back to a binary string.
 */
export function TextParser(partDef) {
  this._partDef = partDef;
  var parser = this._parser = new MimeParser();
  this._totalBytes = 0;

  // TODO: escape?
  var charsetPart = '', formatPart = '';
  if (partDef.params && partDef.params.charset) {
    charsetPart = '; charset="' + partDef.params.charset.toLowerCase() + '"';
  }

  if (partDef.params && partDef.params.format) {
    formatPart = '; format="' + partDef.params.format.toLowerCase() + '"';
  }
  parser.write('Content-Type: ' + partDef.type.toLowerCase() +
               '/' + partDef.subtype.toLowerCase() + charsetPart +
               formatPart + '\r\n');

  if (partDef.encoding) {
    parser.write('Content-Transfer-Encoding: ' + partDef.encoding + '\r\n');
  }

  parser.write('\r\n'); // Finish headers.
}

TextParser.prototype = {
  parse: function(buffer) {
    this._totalBytes += buffer.length;
    this._parser.write(buffer);
  },

  complete: function() {
    this._parser.end();

    // If this part was empty, we won't have any data in `this._parser`.
    if (this._totalBytes === 0) {
      return {
        bytesFetched: 0,
        text: ''
      };
    }

    var str = mimefuncs.charset.decode(this._parser.node.content, 'utf-8');

    return {
      bytesFetched: this._totalBytes,
      text: str
    };
  }
};
