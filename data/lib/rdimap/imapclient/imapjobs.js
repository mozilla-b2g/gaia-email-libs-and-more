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
    './util',
    'exports'
  ],
  function(
    $imaputil,
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

function ImapJobDriver(account) {
  this.account = account;
}
exports.ImapJobDriver = ImapJobDriver;
ImapJobDriver.prototype = {
  /**
   * Request access to an IMAP folder to perform a mutation on it.  This
   * compels the ImapFolderConn in question to acquire an IMAP connection
   * if it does not already have one.  It will also XXX EVENTUALLY provide
   * mututal exclusion guarantees that there are no other active requests
   * in the folder.
   *
   * The callback will be invoked with the folder and raw connections once
   * they are available.  The raw connection will be actively in the folder.
   *
   * This will ideally be migrated to whatever mechanism we end up using for
   * mailjobs.
   */
  _accessFolderForMutation: function(folderId, callback) {
    var storage = this.account.getFolderStorageForFolderId(folderId);
    // XXX have folder storage be in charge of this / don't violate privacy
    storage._pendingMutationCount++;
    if (!storage.folderConn._conn) {
      storage.folderConn.acquireConn(callback);
    }
    else {
      callback(storage.folderConn);
    }
  },

  _doneMutatingFolder: function(folderId, folderConn) {
    var storage = this.account.getFolderStorageForFolderId(folderId);
    // XXX have folder storage be in charge of this / don't violate privacy
    storage._pendingMutationCount--;
    if (!storage._slices.length && !storage._pendingMutationCount)
      storage.folderConn.relinquishConn();
  },

  local_do_modtags: function(op, ignoredCallback, undo) {
    var addTags = undo ? op.removeTags : op.addTags,
        removeTags = undo ? op.addTags : op.removeTags;
    function modifyHeader(header) {
      var iTag, tag, existing, modified = false;
      if (addTags) {
        for (iTag = 0; iTag < addTags.length; iTag++) {
          tag = addTags[iTag];
          // The list should be small enough that native stuff is better than
          // JS bsearch.
          existing = header.flags.indexOf(tag);
          if (existing !== -1)
            continue;
          header.flags.push(tag);
          header.flags.sort(); // (maintain sorted invariant)
          modified = true;
        }
      }
      if (removeTags) {
        for (iTag = 0; iTag < removeTags.length; iTag++) {
          tag = removeTags[iTag];
          existing = header.flags.indexOf(tag);
          if (existing === -1)
            continue;
          header.flags.splice(existing, 1);
          modified = true;
        }
      }
      return modified;
    }

    var lastFolderId = null, lastStorage;
    for (var i = 0; i < op.messages.length; i++) {
      var msgNamer = op.messages[i],
          lslash = msgNamer.suid.lastIndexOf('/'),
          // folder id's are strings!
          folderId = msgNamer.suid.substring(0, lslash),
          // uid's are not strings!
          uid = parseInt(msgNamer.suid.substring(lslash + 1)),
          storage;
      if (folderId === lastFolderId) {
        storage = lastStorage;
      }
      else {
        storage = lastStorage =
          this.account.getFolderStorageForFolderId(folderId);
        lastFolderId = folderId;
      }
      storage.updateMessageHeader(msgNamer.date, uid, false, modifyHeader);
    }

    return null;
  },

  do_modtags: function(op, callback, undo) {
    var partitions = $imaputil.partitionMessagesByFolderId(op.messages, true);
    var folderConn, self = this,
        folderId = null, messages = null,
        iNextPartition = 0, curPartition = null, modsToGo = 0;

    var addTags = undo ? op.removeTags : op.addTags,
        removeTags = undo ? op.addTags : op.removeTags;

    // Perform the 'undo' in the opposite order of the 'do' so that our progress
    // count is always relative to the normal order.
    if (undo)
      partitions.reverse();

    function openNextFolder() {
      if (iNextPartition >= partitions.length) {
        done(null);
        return;
      }

      curPartition = partitions[iNextPartition++];
      messages = curPartition.messages;
      if (curPartition.folderId !== folderId) {
        if (folderConn) {
          self._doneMutatingFolder(folderId, folderConn);
          folderConn = null;
        }
        folderId = curPartition.folderId;
        self._accessFolderForMutation(folderId, gotFolderConn);
      }
    }
    function gotFolderConn(_folderConn) {
      folderConn = _folderConn;
      if (addTags) {
        modsToGo++;
        folderConn._conn.addFlags(messages, addTags, tagsModded);
      }
      if (removeTags) {
        modsToGo++;
        folderConn._conn.delFlags(messages, removeTags, tagsModded);
      }
    }
    function tagsModded(err) {
      if (err) {
        console.error('failure modifying tags', err);
        done('unknown');
        return;
      }
      op.progress += (undo ? -curPartition.messages.length
                           : curPartition.messages.length);
      if (--modsToGo === 0)
        openNextFolder();
    }
    function done(errString) {
      if (folderConn) {
        self._doneMutatingFolder(folderId, folderConn);
        folderConn = null;
      }
      callback(errString);
    }
    openNextFolder();
  },

  check_modtags: function() {
    return UNCHECKED_IDEMPOTENT;
  },

  local_undo_modtags: function(op, callback) {
    // Undoing is just a question of flipping the add and remove lists.
    return this.local_do_modtags(op, callback, true);
  },

  undo_modtags: function(op, callback) {
    // Undoing is just a question of flipping the add and remove lists.
    return this.do_modtags(op, callback, true);
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
   *
   * XXX update
   */
  do_append: function(op, callback) {
    var folderConn, self = this,
        storage = this.account.getFolderStorageForFolderId(op.folderId),
        folderMeta = storage.folderMeta,
        iNextMessage = 0;

    function gotFolderConn(_folderConn) {
      if (!_folderConn) {
        done('unknown');
        return;
      }
      folderConn = _folderConn;
      if (folderConn._conn.hasCapability('MULTIAPPEND'))
        multiappend();
      else
        append();
    }
    function multiappend() {
      iNextMessage = op.messages.length;
      folderConn._conn.multiappend(op.messages, appended);
    }
    function append() {
      var message = op.messages[iNextMessage++];
      folderConn._conn.append(
        message.messageText,
        message, // (it will ignore messageText)
        appended);
    }
    function appended(err) {
      if (err) {
        console.error('failure appending message', err);
        done('unknown');
        return;
      }
      if (iNextMessage < op.messages.length)
        append();
      else
        done(null);
    }
    function done(errString) {
      if (folderConn) {
        self._doneMutatingFolder(op.folderId, folderConn);
        folderConn = null;
      }
      callback(errString);
    }

    this._accessFolderForMutation(op.folderId, gotFolderConn);
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
