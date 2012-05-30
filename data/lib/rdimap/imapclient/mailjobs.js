/**
 * Abstractions for dealing with the various mutation operations.
 *
 * NB: Moves discussion is speculative at this point; we are just thinking
 * things through for architectural implications.
 *
 * == Speculative Operations ==
 *
 * We want our UI to update as soon after requesting an operation as possible.
 * To this end, we have logic to locally apply queued mutation operations.
 * Because we may want to undo operations when we are offline (and have not
 * been able to talk to the server), we also need to be able to reflect these
 * changes locally independent of telling the server.
 *
 * In the case of moves/copies, we issue temporary UIDs like Thunderbird.  We
 * use negative values since IMAP servers can never use them so collisions are
 * impossible and it's a simple check.  This differs from Thunderbird's attempt
 * to guess the next UID; we don't try to do that because the chances are good
 * that our information is out-of-date and it would just make debugging more
 * confusing.
 *
 * == Data Integrity ==
 *
 * Our strategy is always to avoid data-loss, so data-destruction actions
 * must always take place after successful confirmation of persistence actions.
 * (Just keeping the data in-memory is not acceptable because we could crash,
 * etc.)
 *
 * It is also our strategy to avoid cluttering up the place as a side-effect
 * of half-done things.  For example, if we are trying to move N messages,
 * but only copy N/2 because of a timeout, we want to make sure that we
 * don't naively retry and then copy those first N/2 messages a second time.
 * This means that we track sub-steps explicitly, and that operations that we
 * have issued and may or may not have been performed by the server will be
 * checked before they are re-attempted.
 **/

define(
  [
    'exports'
  ],
  function(
    exports
  ) {

/**
 * The evidence suggests the job has not yet been performed.
 */
const CHECKED_NOTYET = 1;
/**
 * The operation is idempotent and atomic; no checking was performed.
 */
const UNCHECKED_IDEMPOTENT = 2;
/**
 * The evidence suggests that the job has already happened.
 */
const CHECKED_HAPPENED = 3;
/**
 * The job is no longer relevant because some other sequence of events
 * have mooted it.  For example, we can't change tags on a deleted message
 * or move a message between two folders if it's in neither folder.
 */
const CHECKED_MOOT = 4;
/**
 * A transient error (from the checker's perspective) made it impossible to
 * check.
 */
const UNCHECKED_BAILED = 5;

function MailJobDriver() {
}
MailJobDriver.prototype = {
  local_do_modtags: function() {
  },

  do_modtags: function() {
  },

  check_modtags: function() {
    return UNCHECKED_IDEMPOTENT;
  },

  local_undo_modtags: function() {
  },

  undo_modtags: function() {
  },

  /**
   * Move the message to the trash folder.  In Gmail, there is no move target,
   * we just delete it and gmail will (by default) expunge it immediately.
   */
  do_delete: function() {
    // set the deleted flag on the message
  },

  check_delete: function() {
    // deleting on IMAP is effectively idempotent
    return UNCHECKED_IDEMPOTENT;
  },

  undo_delete: function() {
  },

  do_move: function() {
    // get a connection in the source folder, uid validity is asserted
    // issue the (potentially bulk) copy
    // wait for copy success
    // mark the source messages deleted
  },

  check_move: function() {
    // get a connection in the target/source folder
    // do a search to check if the messages got copied across.
  },

  /**
   * Move the message back to its original folder.
   *
   * - If the source message has not been expunged, remove the Deleted flag from
   *   the source folder.
   * - If the source message was expunged, copy the message back to the source
   *   folder.
   * - Delete the message from the target folder.
   */
  undo_move: function() {
  },

  do_copy: function() {
  },

  check_copy: function() {
    // get a connection in the target folder
    // do a search to check if the message got copied across
  },

  /**
   * Delete the message from the target folder if it exists.
   */
  undo_copy: function() {
  },

  /**
   * Append a message to a folder.
   */
  do_append: function() {
  },

  /**
   * Check if the message ended up in the folder.
   */
  check_append: function() {
  },

  undo_append: function() {
  },
};

function HighLevelJobDriver() {
}
HighLevelJobDriver.prototype = {
  /**
   * Perform a cross-folder move:
   *
   * - Fetch the entirety of a message from the source location.
   * - Append the entirety of the message to the target location.
   * - Delete the message from the source location.
   */
  do_xmove: function() {
  },

  check_xmove: function() {

  },

  /**
   * Undo a cross-folder move.  Same idea as for normal undo_move; undelete
   * if possible, re-copy if not.  Delete the target once we're confident
   * the message made it back into the folder.
   */
  undo_xmove: function() {
  },

  /**
   * Perform a cross-folder copy:
   * - Fetch the entirety of a message from the source location.
   * - Append the message to the target location.
   */
  do_xcopy: function() {
  },

  check_xcopy: function() {
  },

  /**
   * Just delete the message from the target location.
   */
  undo_xcopy: function() {
  },
};

}); // end define
