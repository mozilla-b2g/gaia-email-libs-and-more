/**
 * mimelib now uses an 'encoding' module to wrap its use of iconv versus
 * iconv-lite.  This is a good thing from our perspective because it allows
 * the API to be more sane.
 **/

define(['utf7', 'exports'], function(utf7, exports) {

// originally from https://github.com/andris9/encoding/blob/master/index.js
// (MIT licensed)
/**
 * Converts charset name from something TextDecoder does not understand to
 * something it does understand for the set of weird charset names we have
 * seen thus far.  Things it does not understand are passed through; you
 * need to be prepared for TextDecoder to throw an exception if you give
 * it something ridiculous.
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
  // TextEncoder only supports utf-8/utf-16be/utf-16le and we will never
  // use a utf-16 encoding, so just hard-code this and save ourselves some
  // weird edge case trouble in the future.
  destEnc = 'utf-8';
  sourceEnc = checkEncoding(sourceEnc || 'utf-8');

  if (destEnc === sourceEnc)
    return new Buffer(str, 'utf-8');
  else if (sourceEnc === 'utf-7' || sourceEnc === 'utf7') {
    // Some versions of Outlook as recently as Outlook 11 produce
    // utf-7-encoded body parts. See <https://bugzil.la/938321>.
    return utf7.decode(str.toString());
  }
  // - decoding (Uint8Array => String)
  else if (/^utf-8$/.test(destEnc)) {
    var decoder;
    // The encoding comes from the message, so it could be anything.
    // TextDecoder throws if it's not a supported encoding, so catch that
    // and fall back to utf-8 decoding in that case so we get something, even
    // if it's full of replacement characters, etc.
    try {
      decoder = new TextDecoder(sourceEnc, ENCODER_OPTIONS);
    }
    catch (ex) {
      // Do log the encoding that we failed to support so that if we get bugs
      // reporting gibberish
      console.warn('Unsupported encoding', sourceEnc, 'switching to utf-8');
      decoder = new TextDecoder('utf-8', ENCODER_OPTIONS);
    }
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
