define(function(require) {
'use strict';

/**
 * This trigger listens to changes on conversations in order to adjust the
 * local unread conversation count for all folders.
 */
return {
  'conv!*!add': function(convInfo) {
    // Nothing to do if this conversation is already fully read.
    if (!convInfo.hasUnread) {
      return;
    }

    // Every folderId it belongs to gets an atomicDelta of 1.
  },

  'conv!*!modify': function(convId, preInfo, convInfo, added, kept, removed) {
    let hasUnread = convInfo ? convInfo.hasUnread : false;

    // If the conversation was read before and is still read, then there are
    // no adjustments to make.
    if (!hasUnread && !preInfo.hasUnread) {
      return;
    }

    // Decrement the unread count of
  }
};
});
