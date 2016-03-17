define(function() {
'use strict';

/**
 * Perform simple assumed safe object attribute traversals.
 */
function FieldExtractor(fieldDefs) {
  let ops = this._ops = [];
  for (let key of Object.keys(fieldDefs)) {
    // This is where we would do any static sanitizing to ensure crazy things
    // aren't being requested.  We might also do a one-off test traversal using
    // hasOwnPropery and maybe some type checking the first time we are invoked,
    // but it's not clear what the threat model would be yet since we won't
    // invoke methods and only methods can do destructive stuff.
    ops.push({
      key,
      traversal: fieldDefs[key]
    });
  }
}
FieldExtractor.prototype = {
  extract: function(gathered, idName, idValue) {
    const extracted = {
      [idName]: idValue
    };
    console.log('traversing', gathered);
    for (let { key, traversal } of this._ops) {
      let curObj = gathered;
      try {
        for (let attr of traversal) {
          curObj = curObj[attr];
        }
      } catch (ex) {
        curObj = null;
      }
      extracted[key] = curObj;
    }
    return extracted;
  }
};

return FieldExtractor;
});
