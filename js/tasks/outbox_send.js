define(function(require) {
'use strict';

let co = require('co');

let TaskDefiner = require('../../task_definer');

/**
 * Account-agnostic outbox sending logic.  (Although it is bound on a per
 * account basis.)  Our persistent state is the set of messages in the outbox
 * folder; we don't do any other tracking.
 */

return TaskDefiner.defineComplexTask([
  {
    name: 'outbox_send',

    /**
     * @return {SyncBodyPersistentState}
     */
    initPersistentState: function() {
      return null;
    },

    /**
     * Scan the list of messages in the outbox and generate a task marker for
     * each one that hasn't been marked as broken.
     *
     */
    deriveMemoryStateFromPersistentState: co.wrap(function*(
        persistentState, db) {
      return {
        memoryState: new Map(),
        markers: []
      };
    }),

    plan: co.wrap(function*(ctx, persistentState, memoryState, rawTask) {
    }),

    execute: co.wrap(function*(ctx, persistentState, memoryState, marker) {
    })
  }
]);
});
