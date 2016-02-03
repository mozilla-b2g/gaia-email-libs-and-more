define(function(require) {
'use strict';

const matchRegexpOrString = require('./match_regexp_or_string');

/**
 * Use matchRegexpOrString under the hood and if we get a match, wrap it into
 * our highlight with the value matched against reported verbatim.  This is
 * in contrast to matchExcerptedHighlight where the entire value is believed to
 * be large and so it has to be snippeted/excerpted.
 */
return function matchExcerptHighlight(searchPattern, value) {
  var ret = matchRegexpOrString(searchPattern, value, 0);
  return {
    text: value,
    offset: 0,
    matchRuns: [{ start: ret.index, length: ret[0].length }],
    path: null,
  };
};
});
