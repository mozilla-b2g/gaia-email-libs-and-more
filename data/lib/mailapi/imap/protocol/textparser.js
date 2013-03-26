define(
  [
    'mailparser/mailparser',
    'exports'
  ],
  function(
   $mailparser,
   exports
  ) {


/**
 * Simple wrapper around mailparser hacks allows us to reuse data from the
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
 */
function TextParser(partDef) {
  var mparser = this._mparser = new $mailparser.MailParser();

  mparser._state = 0x2; // body
  mparser._remainder = '';
  mparser._currentNode = null;
  mparser._currentNode = mparser._createMimeNode(null);
  // nb: mparser._multipartTree is an empty list (always)
  mparser._currentNode.meta.contentType =
    partDef.type.toLowerCase() + '/' +
    partDef.subtype.toLowerCase();

  mparser._currentNode.meta.charset =
    partDef.params && partDef.params.charset &&
    partDef.params.charset.toLowerCase();

  mparser._currentNode.meta.transferEncoding =
    partDef.encoding && partDef.encoding.toLowerCase();

  mparser._currentNode.meta.textFormat =
    partDef.params && partDef.params.format &&
    partDef.params.format.toLowerCase();

  if (partDef.pendingBuffer) {
    this.parse(partDef.pendingBuffer);
  }
}

TextParser.prototype = {
  parse: function(buffer) {
    process.immediate = true;
    this._mparser.write(buffer);
    process.immediate = false;
  },

  complete: function(msg) {
    process.immediate = true;
    this._mparser._process(true);
    process.immediate = false;
    // We end up having provided an extra newline that we don't want, so let's
    // cut it off if it exists.
    var content = this._mparser._currentNode.content;
    if (content.charCodeAt(content.length - 1) === 10)
      content = content.substring(0, content.length - 1);

    return {
      bytesFetched: msg.size,
      text: content
    };
  }
};

exports.TextParser = TextParser;

});
