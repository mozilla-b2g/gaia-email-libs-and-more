define(function() {
'use strict';

/**
 * Given a filter's args object that could be any of many things (but probably
 * a string), return a search pattern thing that our matcher helpers understand.
 * In the future this could maybe be some complicated text boolean thing or a
 * tunneled regexp or something.
 */
return function searchPatternFromArgs(args) {
  if (typeof(args) === 'string') {
    return args;
  }
  if (args && args.phrase) {
    return args.phrase;
  }
  throw new Error('unable to figure out a search pattern from the args');
};
});
