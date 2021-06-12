/**
 * Check if a string or a regexp matches an input and if it does, it returns a
 * 'return value' as RegExp.exec does.  Note that the 'index' of the returned
 * value will be relative to the provided `fromIndex` as if the string had been
 * sliced using fromIndex.
 */
export default function matchRegexpOrString(phrase, input, fromIndex) {
  if (!input) {
    return null;
  }

  if (phrase instanceof RegExp) {
    return phrase.exec(fromIndex ? input.slice(fromIndex) : input);
  }
  // TODO: Eliminate the string code-path and naming.  We probably do want to
  // keep the slightly abstract concept of search pattern since it could let us
  // do some higher level string matching that is beyond regexps but without us
  // having to do indexOf all over the place.

  var idx = input.indexOf(phrase, fromIndex);
  if (idx === -1) {
    return null;
  }

  var ret = [ phrase ];
  ret.index = idx - fromIndex;
  return ret;
}
