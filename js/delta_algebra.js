define(function(require) {
'use strict';

/**
 * Helper functions for dealing with add/remove changes to a value.
 **/

/**
 * Given a list of values and a lists to add and/or remove, compute what
 * actually needs to be added or removed accounting for the current values.
 * Manipulations that are moot like adding something that's already in the list
 * of values or remove something that's not in the list are filtered out in
 * the resulting lists that are generated.
 */
function normalizeAndApplyChanges(values, toAdd, toRemove) {
  let actuallyAdded = null;
  let actuallyRemoved = null;
  if (toAdd) {
    for (let addend of toAdd) {
      if (values.indexOf(addend === -1)) {
        if (!actuallyAdded) {
          actuallyAdded = [];
        }
        values.push(addend);
        actuallyAdded.push(addend);
      }
    }
  }
  if (toRemove) {
    for (let subtrahend of toRemove) { // (wiktionary consulted...)
      let index = values.indexOf(subtrahend);
      if (index !== -1) {
        if (!actuallyRemoved) {
          actuallyRemoved = [];
        }
        values.splice(index, 1);
        actuallyRemoved.push(subtrahend);
      }
    }
  }
  return { add: actuallyAdded, remove: actuallyRemoved };
}

/**
 * Apply the { add, remove } changes in `changes` to `values` by mutating
 * `values`.
 */
function applyChanges(value, changes) {
  if (changes.add) {
    for (let addend of changes.add) {
      if (value.indexOf(addend) === -1) {
        value.push(addend);
      }
    }
  }
  if (changes.remove) {
    for (let subtrahend of changes.remove) {
      let index = value.indexOf(subtrahend);
      if (index !== -1) {
        value.splice(subtrahend, 1);
      }
    }
  }
}


function concatLists(a, b) {
  if (a && b) {
    return a.concat(b);
  } else if (a) {
    return a;
  } else {
    return b;
  }
}


/**
 * Merge an additional set of changes into an existing set of changes.  This is
 * more than just concatenation; things can cancel out.  A functional usage
 * pattern is assumed and conformed to.  We will not mutate any of the lists
 * passed in, but may reuse them if we have no changes to make.
 */
function mergeChanges(existingChanges, newChanges) {
  let derivedAdd;
  let derivedRemove;

  // We have to look for cancellation if there are any live add/remove pairs.
  if ((existingChanges.add && newChanges.remove) ||
      (existingChanges.remove && newChanges.add)) {
    // newChanges.remove and existingChanges.add cancel each other out
    derivedAdd = [];
    let pendingRemove = new Set(newChanges.remove);
    if (existingChanges.add) {
      for (let item of existingChanges.add) {
        if (pendingRemove.has(item)) {
          pendingRemove.delete(item);
        } else {
          derivedAdd.push(item);
        }
      }
    }
    // newChanges.add and existingChanges.remove cancel each other out
    derivedRemove = [];
    let pendingAdd = new Set(newChanges.add);
    if (existingChanges.remove) {
      for (let item of existingChanges.remove) {
        if (pendingAdd.has(item)) {
          pendingAdd.delete(item);
        } else {
          derivedRemove.push(item);
        }
      }
    }
    // Now stitch together the results of those two cancellation passes.
    derivedAdd = concatLists(derivedAdd, Array.from(pendingAdd));
    derivedRemove = concatLists(derivedRemove, Array.from(pendingRemove));
  }
  // Otherwise we can just concatenate as needed
  else {
    derivedAdd = concatLists(existingChanges.add, newChanges.add);
    derivedRemove = concatLists(existingChanges.remove, newChanges.remove);
  }

  // Normalize empty lists to be null.
  if (derivedAdd && !derivedAdd.length) {
    derivedAdd = null;
  }
  if (derivedRemove && !derivedRemove.length) {
    derivedRemove = null;
  }

  return {
    add: derivedAdd,
    remove: derivedRemove
  };
}

return {
  normalizeAndApplyChanges,
  applyChanges,
  mergeChanges
};
});
