define(function() {
'use strict';

const co = require('co');

/**
 * See `TaskDefiner.defineAtMostOnceTask` for a consumer view and high-level
 * overview.  We are implementation details.
 *
 * ## State Management ##
 *
 * Our markers are logically the same as that of a planned task, although
 * obviously we maintain
 *
 * ##
 */
return {
  isSimple: false,
  isComplex: true,

  initPersistentState: function() {
    return new Map();
  },

  deriveMemoryStateFromPersistentState: function(persistentState, accountId) {
    return {
      memoryState,
      markers
    };
  },

  /**
   * Checks if an existing task already exists.  If it does, we do nothing other
   * than
   */
  plan: co.wrap(function*(ctx, persistentState, memoryState, req) {

  }),

  execute: co.wrap(function*(ctx, persistentState, memoryState, marker) {
  })
};
});
