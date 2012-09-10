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
    name = (name || "").toString().trim().
        replace(/^latin[\-_]?(\d+)$/i, "ISO-8859-$1").
        replace(/^win(?:dows)?[\-_]?(\d+)$/i, "WINDOWS-$1").
        replace(/^utf[\-_]?(\d+)$/i, "UTF-$1").
        replace(/^ks_c_5601\-1987$/i, "CP949").
        replace(/^us[\-_]?ascii$/i, "ASCII").
        toUpperCase();
    return name;
}

var ENCODER_OPTIONS = { fatal: false };

exports.convert = function(str, destEnc, sourceEnc, ignoredUseLite) {
  destEnc = checkEncoding(destEnc || 'UTF-8');
  sourceEnc = checkEncoding(sourceEnc || 'UTF-8');

  if (destEnc === sourceEnc)
    return new Buffer(str, 'UTF-8');

  // - decoding (Uint8Array => String)
  else if (/^UTF-8/.test(destEnc)) {
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
