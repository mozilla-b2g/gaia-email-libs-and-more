/**
 * Wrap the stringencoding polyfill (or standard, if that has happend :) so that
 * it resembles the node iconv binding.  Note that although iconv proper
 * supports transliteration, the module we are replacing (iconv-lite) did not,
 * and we don't need transliteration for e-mail anyways.  We only need
 * conversions to process non-unicode encodings into encoding; we will never try
 * and convert the more full unicode character-space into legacy encodings.
 *
 * This assumes our node-buffer.js shim is in use and providing the global Buffer.
 **/

define(function(require, exports, module) {

var ENCODER_OPTIONS = { fatal: false };

exports.Iconv = function Iconv(sourceEnc, destEnc) {

  // - decoding
  if (/^UTF-8/.test(destEnc)) {
    this.decode = true;
    this.coder = new TextDecoder(sourceEnc, ENCODER_OPTIONS);
  }
  // - encoding
  else {
    var idxSlash = destEnc.indexOf('/');
    // ignore '//TRANSLIT//IGNORE' and the like.
    if (idxSlash !== -1 && destEnc[idxSlash+1] === '/')
      destEnc = destEnc.substring(0, idxSlash);
    this.decode = false;
    this.coder = new TextEncoder(destEnc, ENCODER_OPTIONS);
  }

};
exports.Iconv.prototype = {
  /**
   * Takes a buffer, returns a (different) buffer.
   */
  convert: function(inbuf) {
    if (this.decode) {
      return this.coder.decode(inbuf);
    }
    else {
      return Buffer(this.coder.encode(inbuf));
    }
  },
};

});
