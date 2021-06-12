define(function() {
'use strict';

/**
 * Taken from the ECMAScript proposal polyfill in the repo:
 * https://github.com/benjamingr/RegExp.escape
 * git commit: de7b32f9f72d15f9d580119963139d1027c46bbe
 * Copyright CC0 1.0 Universal Benjamin Gruenbaum 2015
 */

function regExpEscape(str) {
  return str.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Given a filter's args object that could be any of many things (but probably
 * a string), return a search pattern thing that our matcher helpers understand.
 *
 * We now upconvert the search pattern to a case-insensitive regexp if it was
 * a string.  Explicitly providing a RegExp was always possible and indeed was
 * what gaia mail did.
 *
 * @param args
 * @param opts
 * @param Boolean [opts.exact=false]
 *   Should this require an exact, albeit case-insensitive match?
 */
return function searchPatternFromArgs(args, opts) {
  let phrase;
  if (!opts) {
    opts = {};
  }
  if ((typeof(args) === 'string') || (args instanceof RegExp)) {
    phrase = args;
  }
  else if (args && args.phrase) {
    phrase = args.phrase;
  }
  else {
    throw new Error('unable to figure out a search pattern from the args');
  }

  if (typeof(phrase) === 'string') {
    let pattern = regExpEscape(phrase);
    if (opts.exact) {
      pattern = '^' + pattern + '$';
    }
    return new RegExp(pattern, 'i');
  } else {
    return phrase;
  }
};
});
