/**
 *
 **/

define(
  [
    'exports'
  ],
  function(
    exports
  ) {

/**
 * Perform a binary search on an array to find the correct insertion point
 *  in the array for an item.  From deuxdrop; tested in
 *  deuxdrop's `unit-simple-algos.js` test.
 *
 * @return[Number]{
 *   The correct insertion point in the array, thereby falling in the inclusive
 *   range [0, arr.length].
 * }
 */
const bsearchForInsert = exports.bsearchForInsert =
    function bsearchForInsert(list, seekVal, cmpfunc) {
  if (!list.length)
    return 0;
  var low  = 0, high = list.length - 1,
      mid, cmpval;
  while (low <= high) {
    mid = low + Math.floor((high - low) / 2);
    cmpval = cmpfunc(seekVal, list[mid]);
    if (cmpval < 0)
      high = mid - 1;
    else if (cmpval > 0)
      low = mid + 1;
    else
      break;
  }
  if (cmpval < 0)
    return mid; // insertion is displacing, so use mid outright.
  else if (cmpval > 0)
    return mid + 1;
  else
    return mid;
};

var bsearchMaybeExists = exports.bsearchMaybeExists =
    function bsearchMaybeExists(list, seekVal, cmpfunc, aLow, aHigh) {
  var low  = ((aLow === undefined)  ? 0                 : aLow),
      high = ((aHigh === undefined) ? (list.length - 1) : aHigh),
      mid, cmpval;
  while (low <= high) {
    mid = low + Math.floor((high - low) / 2);
    cmpval = cmpfunc(seekVal, list[mid]);
    if (cmpval < 0)
      high = mid - 1;
    else if (cmpval > 0)
      low = mid + 1;
    else
      return mid;
  }
  return null;
};


}); // end define
