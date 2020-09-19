import matchRegexpOrString from './match_regexp_or_string';

/**
 * Use matchRegexpOrString under the hood and if we get a match, wrap it into
 * a `FilterMatchItem` with the value matched against reported verbatim.  This
 * is in contrast to matchExcerptHighlight where the entire value is believed
 * to be large and so it has to be snippeted/excerpted.
 */
export default function matchVerbatimHighlight(searchPattern, value, path) {
  var match = matchRegexpOrString(searchPattern, value, 0);
  if (!match) {
    return null;
  }
  return {
    text: value,
    offset: 0,
    matchRuns: [{ start: match.index, length: match[0].length }],
    path: path || null
  };
}

