define(function(require) {
'use strict';

let co = require('co');
let TaskDefiner = require('../task_definer');

/**
 * Creates a new message (either a blank one, a reply, or a forward) and saves
 * it to the database.  The MailBridge can then read and send that (largely
 * normal) message rep to the front-end.
 *
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'draft_create',
    args: ['accountId'],

    exclusiveResources: function(args) {
      return [
        `account:${args.accountId}`
      ];
    },

    priorityTags: function() {
      return [
      ];
    },

    plan: function() {

    },

    execute: null
  }
]);
});
