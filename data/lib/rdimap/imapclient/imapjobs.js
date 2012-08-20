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
 * In the case of moves/copies, we issue a(n always locally created) id for the
 * message immediately and just set the server UID (srvid) to 0 to be populated
 * by the sync process.
 *
 * == Data Integrity ==
 *
 * Our strategy is always to avoid server data-loss, so data-destruction actions
 * must always take place after successful confirmation of persistence actions.
 * (Just keeping the data in-memory is not acceptable because we could crash,
 * etc.)
 *
 * This is in contrast to our concern about losing simple, frequently performed
 * idempotent user actions in a crash.  We assume that A) crashes will be
 * rare, B) the user will not be surprised or heart-broken if a message they
 * marked read a second before a crash needs to manually be marked read after
 * restarting the app/device, and C) there are performance/system costs to
 * saving the state which makes this a reasonable trade-off.
 *
 * It is also our strategy to avoid cluttering up the place as a side-effect
 * of half-done things.  For example, if we are trying to move N messages,
 * but only copy N/2 because of a timeout, we want to make sure that we
 * don't naively retry and then copy those first N/2 messages a second time.
 * This means that we track sub-steps explicitly, and that operations that we
 * have issued and may or may not have been performed by the server will be
 * checked before they are re-attempted.  (Although IMAP batch operations
 * are atomic, and our IndexedDB commits are atomic, they are atomic independent
 * of each other and so we could have been notified that the copy completed
 * but not persisted the fact to our database.)
 *
 * In the event we restore operations from disk that were enqueued but
 * apparently not run, we compel them to run a check operation before they are
 * performed because it's possible (depending on the case) for us to have run
 * them without saving the account state first.  This is a trade-off between the
 * cost of checking and the cost of issuing commits to the database frequently
 * based on the expected likelihood of a crash on our part.  Per comments above,
 * de expect crashes to be rare and not particularly correlated with operations,
 * so it's better for the device (both flash and performance) if we don't
 * continually checkpoint our state.
 *
 * All non-idempotent operations / operations that could result in data loss or
 * duplication require that we save our account state listing the operation and
 * that it is 'doing'.  In the event of a crash, this allows us to know that we
 * have to check the state of the operation for completeness before attempting
 * to run it again and allowing us to finish half-done things.  For particular
 * example, because moves consist of a copy followed by flagging a message
 * deleted, it is of the utmost importance that we don't get in a situation
 * where we have copied the messages but not deleted them and we crash.  In
 * that case, if we failed to persist our plans, we will have duplicated the
 * message (and the IMAP server would have no reason to believe that was not
 * our intent.)
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
 * The operation is idempotent and atomic, just perform the operation again.
 * No checking performed.
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
/**
 * The job has not yet been performed, and the evidence is that the job was
 * not marked finished because our database commits are coherent.  This is
 * appropriate for retrieval of information, like the downloading of
 * attachments.
 */
const UNCHECKED_COHERENT_NOTYET = 6;

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
      callback(storage.folderConn, storage);
    }
  },

  _doneMutatingFolder: function(folderId, folderConn) {
    var storage = this.account.getFolderStorageForFolderId(folderId);
    // XXX have folder storage be in charge of this / don't violate privacy
    storage._pendingMutationCount--;
    if (!storage._slices.length && !storage._pendingMutationCount)
      storage.folderConn.relinquishConn();
  },

  //////////////////////////////////////////////////////////////////////////////
  // download: Download one or more attachments from a single message

  local_do_download: function(op, ignoredCallback) {
    // Downloads are inherently online operations.
    return null;
  },

  do_download: function(op, callback) {
    var self = this;
    var idxLastSlash = op.messageSuid.lastIndexOf('/'),
        folderId = op.messageSuid.substring(0, idxLastSlash),
        uid = op.messageSuid.substring(idxLastSlash + 1);

    var folderConn, folderStorage;
    // Once we have the connection, get the current state of the body rep.
    var gotConn = function gotConn(_folderConn, _folderStorage) {
      folderConn = _folderConn;
      folderStorage = _folderStorage;

      folderStorage.getMessageBody(op.messageSuid, op.messageDate, gotBody);
    };
    // Now that we have the body, we can know the part numbers and eliminate /
    // filter out any redundant download requests.  Issue all the fetches at
    // once.
    var partsToDownload = [], bodyInfo;
    var gotBody = function gotBody(_bodyInfo) {
      bodyInfo = _bodyInfo;
      var i, partInfo;
      for (i = 0; i < op.relPartIndices.length; i++) {
        partInfo = bodyInfo.relatedParts[op.relPartIndices[i]];
        if (partInfo.file)
          continue;
        partsToDownload.push(partInfo);
      }
      for (i = 0; i < op.attachmentIndices.length; i++) {
        partInfo = bodyInfo.attachments[op.attachmentIndices[i]];
        if (partInfo.file)
          continue;
        partsToDownload.push(partInfo);
      }

      folderConn.downloadMessageAttachments(uid, partsToDownload, gotParts);
    };
    var gotParts = function gotParts(err, bodyBuffers) {
      if (bodyBuffers.length !== partsToDownload.length) {
        callback(err, null, false);
        return;
      }
      for (var i = 0; i < partsToDownload.length; i++) {
        // Because we should be under a mutex, this part should still be the
        // live representation and we can mutate it.
        var partInfo = partsToDownload[i],
            buffer = bodyBuffers[i];

        partInfo.sizeEstimate = buffer.length;
        partInfo.file = new Blob([buffer],
                                 { contentType: partInfo.type });
      }
      folderStorage.updateMessageBody(op.messageSuid, op.messageDate, bodyInfo);
      callback(err, bodyInfo, true);
    };

    self._accessFolderForMutation(folderId, gotConn);
  },

  check_download: function(op, callback) {
    // If we had download the file and persisted it successfully, this job would
    // be marked done because of the atomicity guarantee on our commits.
    return UNCHECKED_COHERENT_NOTYET;
  },

  local_undo_download: function(op, ignoredCallback) {
    return null;
  },

  undo_download: function(op, callback) {
    callback();
  },


  //////////////////////////////////////////////////////////////////////////////
  // modtags: Modify tags on messages

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

  //////////////////////////////////////////////////////////////////////////////
  // delete: Delete messages

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

  //////////////////////////////////////////////////////////////////////////////
  // move: Move messages between folders (in a single account)
  //
  // ## General Strategy ##
  //
  // Local Do:
  //
  // - Move the header to the target folder's storage.
  //
  //   This requires acquiring a write mutex to the target folder while also
  //   holding one on the source folder.  We are assured there is no deadlock
  //   because only operations are allowed to manipulate multiple folders at
  //   once, and only one operation is in-flight per an account at a time.
  //   (And cross-account moves are not handled by this operation.)
  //
  //   Insertion is done using the INTERNALDATE (which must be maintained by the
  //   COPY operation) and a freshly allocated speculative UID.  The UID is
  //
  // ## Possible Problems and their Solutions ##
  //
  // Moves are fairly complicated in terms of moving parts, so let's enumate the
  // way things could go wrong so we can make sure we address them and describe
  // how we address them.  Note that it's a given that we will have run our
  // local modifications prior to trying to talk to the server, which reduces
  // the potential badness.
  //
  // #1: We attempt to resynchronize the source folder for a move prior to
  //     running the operation against the server, resulting in us synchronizing
  //     a duplicate header into existence that will not be detected until the
  //     next resync of the time range (which will be strictly after when we
  //     actually run the mutation.
  //
  // #2: Operations scheduled against speculative headers.  It is quite possible
  //     for the user to perform actions against one of the locally /
  //     speculatively moved headers while we are offline/have not yet played
  //     the operation/are racing the UI while playing the operation.  We
  //     obviously want these changes to succeed.
  //
  // Our solutions:
  //
  // #1: Prior to resynchronizing a folder, we check if there are any operations
  //     that block synchronization.  An un-run move with a source of that
  //     folder counts as such an operation.  We can determine this by either
  //     having sufficient knowledge to inspect an operation or have operations
  //     directly modify book-keeping structures in the folders as part of their
  //     actions.  (Add blocker on local_(un)do, remove on (un)do.)  We choose
  //     to implement the inspection operation by having all operations
  //     implement a simple helper to tell us if the operation blocks entry.
  //     The theory is this will be less prone to bugs since it will be clear
  //     that operations need to implement the method, whereas it would be less
  //     clear that operations need to do call the folder-state mutating
  //     options.
  //
  // #2: Operations against speculative headers are a concern only from a naming
  //     perspective for operations.  Operations are strictly run in the order
  //     they are enqueued, so we know that the header will have been moved and
  //     be in the right folder.  Additionally, because both the UI and
  //     operations name messages using an id we issue rather than the server
  //     UID, there is no potential for naming inconsistencies.  The UID will be
  //     resolved at operation run-time which only requires that the move was
  //     UIDPLUS so we already know the UID, something else already triggered a
  //     synchronization that covers the messages being moved, or that we
  //     trigger a synchronization.


  local_do_move: function() {
  },

  do_move: function() {
    // get a connection in the source folder, uid validity is asserted
    // issue the (potentially bulk) copy
    // wait for copy success
    // mark the source messages deleted
  },

  /**
   * Verify the move results.  This is most easily/efficiently done, from our
   * perspective, by checking based on message-id's.  Another approach would be
   * to leverage the persistence of the
   *
   */
  check_move: function() {
    // get a connection in the target folder
    // do a search on message-id's to check if the messages got copied across.
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

  //////////////////////////////////////////////////////////////////////////////
  // copy: Copy messages between folders (in a single account)

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

  //////////////////////////////////////////////////////////////////////////////
  // append: Add a message to a folder

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

  //////////////////////////////////////////////////////////////////////////////
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
