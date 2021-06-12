import matchRegexpOrString from './match_regexp_or_string';

/**
 * Use matchRegexpOrString under the hood against a very large string and if we
 * get a match, find an appropriate excerpt window around the match.  Compare
 * with `matchVerbatimHighlight` where no excerpting is done because we assume
 * the string is so short that the highlight will definitely be visible.
 *
 * Excerpting tries to be clever and break things along word boundaries, but
 * it's likely certain we could do a better job.
 *
 * Note that the original pre-convoy implementation was just
 * `snippetMatchHelper` and depended on the caller to drive a process where
 * multiple snippet excerpts might be generated.  Our UX never ended up actually
 * desiring multiple matches, so we're simpliyfing things here.  There's a
 * fair chance we may eventually want to fancy this up to support multiple
 * matches in a block, but we'll probably do that in this method and having the
 * call-sites plumb more settings through to us.
 */
export default function matchExcerptHighlight(searchPattern, value, path,
                                      excerptSettings) {
  var match = matchRegexpOrString(searchPattern, value, 0);
  if (!match) {
    return null;
  }

  let { charsBefore: contextBefore, charsAfter: contextAfter } =
    excerptSettings;

  let start = match.index;
  let length = match[0].length;

  // We can't start earlier than the beginning.
  if (contextBefore > start) {
    contextBefore = start;
  }
  let offset = value.indexOf(' ', start - contextBefore);
  // Just fragment the preceding word if there was no match whatsoever or the
  // whitespace match happened preceding our word or anywhere after it.
  if (offset === -1 || offset >= (start - 1)) {
    offset = start - contextBefore;
  }
  else {
    // do not start on the space character
    offset++;
  }

  var endIdx;
  if (start + length + contextAfter >= value.length) {
    endIdx = value.length;
  }
  else {
    endIdx = value.lastIndexOf(' ', start + length + contextAfter - 1);
    if (endIdx <= start + length) {
      endIdx = start + length + contextAfter;
    }
  }
  var snippet = value.substring(offset, endIdx);

  return {
    text: snippet,
    offset: offset,
    matchRuns: [{ start: start - offset, length }],
    path
  };
}
