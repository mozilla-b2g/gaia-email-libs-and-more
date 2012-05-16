/**
 * Provides unified account/folder functionality.
 **/

define(
  [
    'exports'
  ],
  function(
    exports
  ) {

/**
 * Stitches together multiple slices to present a unified folder.  This is
 * fairly straightforward; when growing in either direction, we first make sure
 * all the underlying slices have the minimum coverage we need, and then we
 * interleave them.
 */
function UnifyingSlice() {
}
UnifyingSlice.prototype = {
};

/**
 * The unified account is a magical account that shows the fused contents of
 * multiple account's folders as if they were one.  It is only created when
 * there are 2 or more accounts defined.  It is never persisted.  Only specific
 * folders are fused, although in theory we could support any folders the
 * user wants.
 *
 * Fused folders:
 * - Inbox (as identified by type)
 * - Drafts (as identified by type)
 * - Sent (as identified by type)
 * - Trash (as identified by type)
 */
function UnifiedAccount(accountDef) {
  // we use an id character that a64 will never assign.
  this.id = '*';
}
UnifiedAccount.prototype = {
};

}); // end define
