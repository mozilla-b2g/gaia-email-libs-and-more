/**
 * mimelib now uses an 'encoding' module to wrap its use of iconv versus
 * iconv-lite.  This is a good thing from our perspective because it allows
 * the API to be more sane.
 **/

define(function(require, exports, module) {

// from https://github.com/andris9/encoding/blob/master/index.js
// (MIT licensed)
/**
 * Converts charset name if needed
 *
 * @param {String} name Character set
 * @return {String} Character set name
 */
function checkEncoding(name){
    name = (name || "").toString().trim().toLowerCase().
        // this handles aliases with dashes and underscores too; built-in
        // aliase are only for latin1, latin2, etc.
        replace(/^latin[\-_]?(\d+)$/, "iso-8859-$1").
        // win949, win-949, ms949 => windows-949
        replace(/^(?:(?:win(?:dows)?)|ms)[\-_]?(\d+)$/, "windows-$1").
        replace(/^utf[\-_]?(\d+)$/, "utf-$1").
        replace(/^us_?ascii$/, "ascii"); // maps to windows-1252
    return name;
}
exports.checkEncoding = checkEncoding;

var ENCODER_OPTIONS = { fatal: false };

exports.convert = function(str, destEnc, sourceEnc, ignoredUseLite) {
  destEnc = checkEncoding(destEnc || 'utf-8');
  sourceEnc = checkEncoding(sourceEnc || 'utf-8');

  if (destEnc === sourceEnc)
    return new Buffer(str, 'utf-8');

  // - decoding (Uint8Array => String)
  else if (/^utf-8$/.test(destEnc)) {
    var decoder = new TextDecoder(sourceEnc, ENCODER_OPTIONS);
    if (typeof(str) === 'string')
      str = new Buffer(str, 'binary');
    // XXX strictly speaking, we should be returning a buffer...
    return decoder.decode(str);
  }
  // - encoding (String => Uint8Array)
  else {
    var idxSlash = destEnc.indexOf('/');
    // ignore '//TRANSLIT//IGNORE' and the like.
    if (idxSlash !== -1 && destEnc[idxSlash+1] === '/')
      destEnc = destEnc.substring(0, idxSlash);

    var encoder = new TextEncoder(destEnc, ENCODER_OPTIONS);
    return encoder.encode(str);
  }
};

});
