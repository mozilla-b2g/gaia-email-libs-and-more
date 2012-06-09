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

exports.partitionMessagesByFolderId =
    function partitionMessagesByFolderId(messageNamers, onlyKeepMsgId) {
  var results = [], foldersToMsgs = {};
  for (var i = 0; i < messageNamers.length; i++) {
    var messageSuid = messageNamers[i].suid,
        idxLastSlash = messageSuid.lastIndexOf('/'),
        folderId = messageSuid.substring(0, idxLastSlash),
        // if we only want the UID, do so, but make sure to parse it as a #!
        useId = onlyKeepMsgId ? parseInt(messageSuid.substring(idxLastSlash+1))
                              : messageSuid;

    if (!foldersToMsgs.hasOwnProperty(folderId)) {
      var messages = [useId];
      results.push({
        folderId: folderId,
        messages: messages,
      });
      foldersToMsgs[folderId] = messages;
    }
    else {
      foldersToMsgs[folderId].push(useId);
    }
  }
  return results;
};

}); // end define
