/**
 * Look like node's Buffer implementation as far as our current callers require
 * using typed arrays.  Derived from the node.js implementation as copied out of
 * the node-browserify project.
 *
 * Be careful about assuming the meaning of encoders and decoders here; we are
 * using the nomenclature of the StringEncoding spec.  So:
 *
 * - encode: JS String --> ArrayBufferView
 * - decode: ArrayBufferView ---> JS String
 **/
define(function(require, exports, module) {

function coerce(length) {
  // Coerce length to a number (possibly NaN), round up
  // in case it's fractional (e.g. 123.456) then do a
  // double negate to coerce a NaN to 0. Easy, right?
  length = ~~Math.ceil(+length);
  return length < 0 ? 0 : length;
}

/**
 * Encode a unicode string into a (Uint8Array) byte array with the given
 * encoding. Wraps TextEncoder to provide hex and base64 encoding (which it does
 * not provide).
 */
function encode(string, encoding) {
  switch (encoding) {
    case 'hex':
      var buf = new Uint8Array(string.length * 2);
      for (var i = 0; i < string.length; i++) {
        var c = string.charCodeAt(i), nib;
        nib = c >> 4;
        buf[i*2] = (nib < 10) ? (nib + 48) : (nib - 10 + 97);
        nib = c & 0xf;
        buf[i*2 + 1] = (nib < 10) ? (nib + 48) : (nib - 10 + 97);
      }
      return buf;
    case 'base64':
      // (atob is base64 ASCII string -> binary JS string)
      // we use the textencoder to go from the binary JS string to the array
      // view. (which is a buffer for our purposes because of our prototype
      // clobbering.)
      return TextEncoder('binary').encode(window.atob(string));
    // need to normalize the name (for now at least)
    case 'utf8':
      encoding = 'utf-8';
    default:
      if (!encoding)
        encoding = 'utf-8';
      return TextEncoder(encoding).encode(string);
  }
}

/**
 * Decode a Uint8Array/DataView into a unicode string given the encoding of the
 * byte stream.  Wrap TextDecoder to provide hex and base64 decoding (which it
 * does not provide).
 */
function decode(view, encoding) {
  switch (encoding) {
    case 'hex':
      var sbits = [];
      for (var i = 0; i < view.length; i += 2) {
        var nib = view[i], c;
        if (nib <= 57)
          c = 16 * (nib - 48);
        else if (nib < 97)
          c = 16 * (nib - 64 + 10);
        else
          c = 16 * (nib - 97 + 10);
        nib = view[i+1];
        if (nib <= 57)
          c += (nib - 48);
        else if (nib < 97)
          c += (nib - 64 + 10);
        else
          c += (nib - 97 + 10);
        sbits.push(String.fromCharCode(c));
      }
      return sbits.join("");
    case 'base64':
      // (btoa is binary JS string -> base64 ASCII string)
      // we need to use the textdecoder to get from the binary array to the
      // binary string; we use 'binary' to avoid truncation/loss.
      return window.btoa(TextDecoder('binary').decode(view));
    // need to normalize the name (for now at least)
    case 'utf8':
      encoding = 'utf-8';
    default:
      if (!encoding)
        encoding = 'utf-8';
      return TextDecoder(encoding).decode(view);
  }
}

/**
 * Create a buffer which is really a typed array with some methods annotated
 * on.
 */
function Buffer(subject, encoding, offset) {
  // The actual buffer that will become 'this'.
  var buf;
  var type;

  // Are we slicing?
  if (typeof offset === 'number') {
    // create a sub-view
    buf = subject.subarray(offset, coerce(encoding) + offset);
  } else {
    // Find the length
    switch (type = typeof subject) {
      case 'number':
        buf = new Uint8Array(coerce(subject));
        break;

      case 'string':
        buf = encode(subject, encoding);
        break;

      case 'object': // Assume object is an array
        // only use it verbatim if it's a buffer and we see it as such (aka
        // it's from our compartment)
        if (buf instanceof Uint8Array)
          buf = subject;
        else
          buf = new Uint8Array(subject);
        break;

      default:
        throw new Error('First argument needs to be a number, ' +
                        'array or string.');
    }
  }

  // Return the mixed-in Uint8Array to be our 'this'!
  return buf;
}
exports.Buffer = Buffer;

Buffer.byteLength = function Buffer_byteLength(string, encoding) {
  var buf = encode(string, encoding);
  return buf.length;
};

Buffer.isBuffer = function Buffer_isBuffer(obj) {
  return ((obj instanceof Uint8Array) &&
          obj.copy === BufferPrototype.copy);
};

// POSSIBLY SUBTLE AND DANGEROUS THING: We are actually clobbering stuff onto
// the Uint8Array prototype.  We do this because we're not allowed to mix our
// contributions onto the instance types, leaving us only able to mess with
// the prototype.  This obviously may affect other consumers of Uint8Array
// operating in the same global-space.
var BufferPrototype = Uint8Array.prototype;

BufferPrototype.copy = function(target, target_start, start, end) {
  var source = this;
  start || (start = 0);
  end || (end = this.length);
  target_start || (target_start = 0);

  if (end < start) throw new Error('sourceEnd < sourceStart');

  // Copy 0 bytes; we're done
  if (end === start) return;
  if (target.length == 0 || source.length == 0) return;

  if (target_start < 0 || target_start >= target.length) {
    throw new Error('targetStart out of bounds');
  }

  if (start < 0 || start >= source.length) {
    throw new Error('sourceStart out of bounds');
  }

  if (end < 0 || end > source.length) {
    throw new Error('sourceEnd out of bounds');
  }

  // Are we oob?
  if (end > this.length) {
    end = this.length;
  }

  if (target.length - target_start < end - start) {
    end = target.length - target_start + start;
  }

  for (var i = start; i < end; i++) {
    target[i + target_start] = this[i];
  }
};

BufferPrototype.slice = function(start, end) {
  if (end === undefined) end = this.length;

  if (end > this.length) {
    throw new Error('oob');
  }
  if (start > end) {
    throw new Error('oob');
  }
  return Buffer(this, end - start, +start);
};

/**
 * Your buffer has some binary data in it; create a string from that data using
 * the specified encoding.  For example, toString("base64") will hex-encode
 * the contents of the buffer.
 */
BufferPrototype.toString = function(encoding, start, end) {
  encoding = String(encoding || 'utf-8').toLowerCase();
  start = +start || 0;
  if (typeof end == 'undefined') end = this.length;

  // Fastpath empty strings
  if (+end == start) {
    return '';
  }
  if (start === 0 && end === this.length)
    return decode(this, encoding);
  else
    return decode(this.subarray(start, end), encoding);
  // In case things get slow again, comment the above block and uncomment:
/*
var rval, before = Date.now();
  if (start === 0 && end === this.length)
    rval = decode(this, encoding);
  else
    rval = decode(this.subarray(start, end), encoding);
  var delta = Date.now() - before;
  if (delta > 2)
    console.error('SLOWDECODE', delta, end - start, encoding);
  return rval;
*/
};

BufferPrototype.write  = function(string, offset, length, encoding) {
  // Support both (string, offset, length, encoding)
  // and the legacy (string, encoding, offset, length)
  if (isFinite(offset)) {
    if (!isFinite(length)) {
      encoding = length;
      length = undefined;
    }
  } else {  // legacy
    var swap = encoding;
    encoding = offset;
    offset = length;
    length = swap;
  }

  offset = +offset || 0;
  var remaining = this.length - offset;
  if (!length) {
    length = remaining;
  } else {
    length = +length;
    if (length > remaining) {
      length = remaining;
    }
  }
  encoding = String(encoding || 'utf-8').toLowerCase();

  var encoded = encode(string, encoding);
  for (var i = 0; i < encoded.length; i++)
    this[i + offset] = encoded[i];

  return encoded.length;
};

});
