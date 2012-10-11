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
 * we expect crashes to be rare and not particularly correlated with operations,
 * so it's better for the device (both flash and performance) if we don't
 * continually checkpoint our state.
 *
 * All non-idempotent operations / operations that could result in data loss or
 * duplication require that we save our account state listing the operation.  In
 * the event of a crash, this allows us to know that we have to check the state
 * of the operation for completeness before attempting to run it again and
 * allowing us to finish half-done things.  For particular example, because
 * moves consist of a copy followed by flagging a message deleted, it is of the
 * utmost importance that we don't get in a situation where we have copied the
 * messages but not deleted them and we crash.  In that case, if we failed to
 * persist our plans, we will have duplicated the message (and the IMAP server
 * would have no reason to believe that was not our intent.)
 **/

define(
  [
    '../util',
    'exports'
  ],
  function(
    $imaputil,
    exports
  ) {

/**
 * The evidence suggests the job has not yet been performed.
 */
const CHECKED_NOTYET = 'checked-notyet';
/**
 * The operation is idempotent and atomic, just perform the operation again.
 * No checking performed.
 */
const UNCHECKED_IDEMPOTENT = 'idempotent';
/**
 * The evidence suggests that the job has already happened.
 */
const CHECKED_HAPPENED = 'happened';
/**
 * The job is no longer relevant because some other sequence of events
 * have mooted it.  For example, we can't change tags on a deleted message
 * or move a message between two folders if it's in neither folder.
 */
const CHECKED_MOOT = 'moot';
/**
 * A transient error (from the checker's perspective) made it impossible to
 * check.
 */
const UNCHECKED_BAILED = 'bailed';
/**
 * The job has not yet been performed, and the evidence is that the job was
 * not marked finished because our database commits are coherent.  This is
 * appropriate for retrieval of information, like the downloading of
 * attachments.
 */
const UNCHECKED_COHERENT_NOTYET = 'coherent-notyet';

/**
 * @typedef[MutationState @dict[
 *   @key[suidToServerId @dictof[
 *     @key[SUID]
 *     @value[ServerID]
 *   ]]{
 *     Tracks the server id (UID on IMAP) for an account as it is currently
 *     believed to exist on the server.  We persist this because the actual
 *     header may have been locally moved to another location already, so
 *     there may not be storage for the information in the folder when
 *     subsequent non-local operations run (such as another move or adding
 *     a tag).
 *
 *     This table is entirely populated by the actual (non-local) move
 *     operations.  Entries remain in this table until they are mooted by a
 *     subsequent move or the table is cleared once all operations for the
 *     account complete.
 *   }
 * ]]
 *
 * @typedef[MutationStateDelta @dict[
 *   @key[serverIdMap @dictof[
 *     @key[suid SUID]
 *     @value[srvid @oneof[null ServerID]]
 *   ]]{
 *     New values for `MutationState.suidToServerId`; set/updated by by
 *     non-local operations once the operation has been performed.  A null
 *     `srvid` is used to convey the header no longer exists at the previous
 *     name.
 *   }
 *   @key[moveMap @dictof[
 *     @key[oldSuid SUID]
 *     @value[newSuid SUID]
 *   ]]{
 *     Expresses the relationship between moved messages by local-operations.
 *     This currently serves as debugging information.  It's not needed
 *     currently because all manipulations are always posed in terms of the
 *     local header's suid and there is no need to discuss the previous suid. It
 *     would be required to implement the ability to undo an operation
 *     out-of-sequence relative to a move or if we wanted to restore the
 *     original suid's of a message when undoing a move.
 *   }
 * ]]{
 *   A set of attributes that can be set on an operation to cause changes to
 *   the `MutationState` for the account.  This forms part of the interface
 *   of the operations.  The operations don't manipulate the table directly
 *   to reduce code duplication, ease debugging, and simplify unit testing.
 * }
 **/

function ImapJobDriver(account, state) {
  this.account = account;
  this._heldMutexReleasers = [];
  this._state = state;
  // (we only need to use one as a proxy for initialization)
  if (!state.hasOwnProperty('suidToServerId')) {
    state.suidToServerId = {};
  }

  this._stateDelta = {
    serverIdMap: null,
    moveMap: null,
  };
}
exports.ImapJobDriver = ImapJobDriver;
ImapJobDriver.prototype = {
  /**
   * Request access to an IMAP folder to perform a mutation on it.  This
   * acquires a write mutex on the FolderStorage and compels the ImapFolderConn
   * in question to acquire an IMAP connection if it does not already have one.
   *
   * The callback will be invoked with the folder and raw connections once
   * they are available.  The raw connection will be actively in the folder.
   *
   * There is no need to explicitly release the connection when done; it will
   * be automatically released when the mutex is released if desirable.
   *
   * This will ideally be migrated to whatever mechanism we end up using for
   * mailjobs.
   *
   * @args[
   *   @param[folderId]
   *   @param[needConn Boolean]{
   *     True if we should try and get a connection from the server.  Local ops
   *     should pass false.
   *   }
   *   @param[callback @func[
   *     @args[
   *       @param[folderConn ImapFolderConn]
   *       @param[folderStorage FolderStorage]
   *     ]
   *   ]]
   *   @param[deathback Function]
   *   @param[label String]{
   *     The label to identify this usage for debugging purposes.
   *   }
   * ]
   */
  _accessFolderForMutation: function(folderId, needConn, callback, deathback,
                                     label) {
    var storage = this.account.getFolderStorageForFolderId(folderId),
        self = this;
    storage.runMutexed(label, function(releaseMutex) {
      self._heldMutexReleasers.push(releaseMutex);
      var syncer = storage.folderSyncer;
      if (needConn && !syncer.folderConn._conn) {
        syncer.folderConn.acquireConn(callback, deathback, label);
      }
      else {
        callback(syncer.folderConn, storage);
      }
    });
  },

  /**
   * Partition messages identified by namers by folder, then invoke the callback
   * once per folder, passing in the loaded message header objects for each
   * folder.
   *
   * @args[
   *   @param[messageNamers @listof[MessageNamer]]
   *   @param[needConn Boolean]{
   *     True if we should try and get a connection from the server.  Local ops
   *     should pass false, server ops should pass true.  This additionally
   *     determines whether we provide headers to the operation (!needConn),
   *     or server id's for messages (needConn).
   *   }
   *   @param[callInFolder @func[
   *     @args[
   *       @param[folderConn ImapFolderConn]
   *       @param[folderStorage FolderStorage]
   *       @param[headers @listof[HeaderInfo]]
   *       @param[callWhenDoneWithFolder Function]
   *     ]
   *   ]]
   *   @param[callWhenDone Function]
   *   @param[reverse #:optional Boolean]{
   *     Should we walk the partitions in reverse order?
   *   }
   *   @param[label String]{
   *     The label to use to name the usage of the folder connection.
   *   }
   * ]
   */
  _partitionAndAccessFoldersSequentially: function(messageNamers,
                                                   needConn,
                                                   callInFolder,
                                                   callWhenDone,
                                                   callOnConnLoss,
                                                   reverse,
                                                   label) {
    var partitions = $imaputil.partitionMessagesByFolderId(messageNamers, true);
    var folderConn, storage, self = this,
        folderId = null, messageIds = null,
        iNextPartition = 0, curPartition = null, modsToGo = 0;

    if (reverse)
      partitions.reverse();

    var openNextFolder = function openNextFolder() {
      if (iNextPartition >= partitions.length) {
        callWhenDone(null);
        return;
      }
      if (iNextPartition) {
        folderConn = null;
        // release the mutex on the folder we were in
        var releaser = self._heldMutexReleasers.pop();
        if (releaser)
          releaser();
        folderConn = null;
      }

      curPartition = partitions[iNextPartition++];
      messageIds = curPartition.messages;
      if (curPartition.folderId !== folderId) {
        folderId = curPartition.folderId;
        self._accessFolderForMutation(folderId, needConn, gotFolderConn,
                                      callOnConnLoss, label);
      }
    };
    var gotFolderConn = function gotFolderConn(_folderConn, _storage) {
      folderConn = _folderConn;
      storage = _storage;
      // - Get headers or resolve current server id from name map
      if (needConn) {
        var neededHeaders = [];
        // XXX server-id/name-lookup stuff
        for (var i = 0; i < curPartition.messages.length; i++) {

        }
      }
      else {
        storage.getMessageHeaders(curPartition.messages, gotHeaders);
      }
    };
    var gotHeaders = function gotHeaders(headers) {
      callInFolder(folderConn, storage, headers, openNextFolder);
    };
    openNextFolder();
  },

  /**
   * Request access to a connection for some type of IMAP manipulation that does
   * not involve a folder known to the system (which should then be accessed via
   * _accessfolderForMutation).
   *
   * The connection will be automatically released when the operation completes,
   * there is no need to release it directly.
   */
  _acquireConnWithoutFolder: function(label, callback, deathback) {
    const self = this;
    this.account.__folderDemandsConnection(
      null, label,
      function(conn) {
        self._heldMutexReleasers.push(function() {
          self.account.__folderDoneWithConnection(conn, false, false);
        });
        callback(conn);
      },
      deathback
    );
  },

  postJobCleanup: function() {
    for (var i = 0; i < this._heldMutexReleasers.length; i++) {
      this._heldMutexReleasers[i]();
    }
    this._heldMutexReleasers = [];

    this._stateDelta.serverIdMap = null;
    this._stateDelta.moveMap = null;
  },

  allJobsDone: function() {
    this._state.suidToServerId = {};
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
        folderId = op.messageSuid.substring(0, idxLastSlash);

    var folderConn, folderStorage;
    // Once we have the connection, get the current state of the body rep.
    var gotConn = function gotConn(_folderConn, _folderStorage) {
      folderConn = _folderConn;
      folderStorage = _folderStorage;

      folderStorage.getMessageHeader(op.messageSuid, op.messageDate, gotHeader);
    };
    var deadConn = function deadConn() {
      callback('aborted-retry');
    };
    // Now that we have the body, we can know the part numbers and eliminate /
    // filter out any redundant download requests.  Issue all the fetches at
    // once.
    var partsToDownload = [], header, bodyInfo, uid;
    var gotHeader = function gotHeader(_headerInfo) {
      header = _headerInfo;
      uid = header.srvid;
      folderStorage.getMessageBody(op.messageSuid, op.messageDate, gotBody);
    };
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

    self._accessFolderForMutation(folderId, true, gotConn, deadConn,
                                  'download');
  },

  check_download: function(op, callback) {
    // If we had download the file and persisted it successfully, this job would
    // be marked done because of the atomicity guarantee on our commits.
    callback(null, UNCHECKED_COHERENT_NOTYET);
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
          // id's are not strings (for IMAP)!
          id = parseInt(msgNamer.suid.substring(lslash + 1)),
          storage;
      if (folderId === lastFolderId) {
        storage = lastStorage;
      }
      else {
        storage = lastStorage =
          this.account.getFolderStorageForFolderId(folderId);
        lastFolderId = folderId;
      }
      storage.updateMessageHeader(msgNamer.date, id, false, modifyHeader);
    }

    return null;
  },

  do_modtags: function(op, jobDoneCallback, undo) {
    var addTags = undo ? op.removeTags : op.addTags,
        removeTags = undo ? op.addTags : op.removeTags;

    var aggrErr = null;

    this._partitionAndAccessFoldersSequentially(
      op.messages, true,
      function perFolder(folderConn, storage, serverIds, callWhenDone) {
        var modsToGo = 0;
        function tagsModded(err) {
          if (err) {
            console.error('failure modifying tags', err);
            aggrErr = 'unknown';
            return;
          }
          op.progress += (undo ? -serverIds.length : serverIds.length);
          if (--modsToGo === 0)
            callWhenDone();
        }
        var uids = [];
        for (var i = 0; i < serverIds.length; i++) {
          var srvid = serverIds[i];
          // If the header is somehow an offline header, it will be zero and
          // there is nothing we can really do for it.
          if (srvid)
            uids.push(srvid);
        }
        if (addTags) {
          modsToGo++;
          folderConn._conn.addFlags(uids, addTags, tagsModded);
        }
        if (removeTags) {
          modsToGo++;
          folderConn._conn.delFlags(uids, removeTags, tagsModded);
        }
      },
      function allDone() {
        jobDoneCallback(aggrErr);
      },
      function deadConn() {
        aggrErr = 'aborted-retry';
      },
      undo, 'modtags');
  },

  check_modtags: function(op, callback) {
    callback(null, UNCHECKED_IDEMPOTENT);
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

  check_delete: function(op, callback) {
    // deleting on IMAP is effectively idempotent
    callback(null, UNCHECKED_IDEMPOTENT);
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
  // - Move the header to the target folder's storage, updating the op with the
  //   message-id header of the message for each message so that the check
  //   operation has them available.
  //
  //   This requires acquiring a write mutex to the target folder while also
  //   holding one on the source folder.  We are assured there is no deadlock
  //   because only operations are allowed to manipulate multiple folders at
  //   once, and only one operation is in-flight per an account at a time.
  //   (And cross-account moves are not handled by this operation.)
  //
  //   Insertion is done using the INTERNALDATE (which must be maintained by the
  //   COPY operation) and a freshly allocated id, just like if we had heard
  //   about the header from the server.
  //
  // Do:
  //
  // - Acquire a connection to the target folder so that we can know the UIDNEXT
  //   value prior to performing the copy.  FUTURE: Don't do this if the server
  //   supports UIDPLUS.
  //
  // (Do the following in a loop per-source folder)
  //
  // - Copy the messages to the target folder via COPY.
  //
  // - Figure out the UIDs of our moved messages.  FUTURE: If the server is
  //   UIDPLUS, we already know these from the results of the previous command.
  //   NOW: Issue a fetch on the message-id headers of the messages in the
  //   range UIDNEXT:*.  Use these results to map the UIDs to the messages we
  //   copied above.  In the event of duplicate message-id's, ordering doesn't
  //   matter, we just pick the first one.  Update our UIDNEXT value in case
  //   there is another pass through the loop.
  //
  // - Issue deletes on the messages from the source folder.
  //
  // Check: XXX TODO POSTPONED FOR PRELIMINARY LANDING
  //
  // NB: Our check implementation actually is a correcting check implemenation;
  // we will make things end up the way they should be.  We do this because it
  // is simpler than 
  //
  // - Acquire a connection to the target folder.  Issue broad message-id
  //   header searches to find if the messages appear to be in the folder
  //   already, note which are already present.  This needs to take the form
  //   of a SEARCH followed by a FETCH to map UIDs to message-id's.  In theory
  //   the IMAP copy command should be atomic, but I'm not sure we can trust
  //   that and we also have the problem where there could already be duplicate
  //   message-id headers in the target which could confuse us if our check is
  //   insufficiently thorough.  The FETCH needs to also retrieve the flags
  //   for the message so we can track deletion state.
  //
  // (Do the following in a loop per source folder)
  //
  // - Acquire connections for each source folder.  Issue message-id searches
  //   like we did for the target including header results.  In theory we might
  //   remember the UIDs for check acceleration purposes, but that would not
  //   cover if we tried to perform an undo, so we go for thorough.
  //
  // -
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
  //     resolved at operation run-time which only requires that the move
  //     operation either was UIDPLUS or we manually sussed out the target id
  //     (which we do for simplicity).
  //
  // XXX problem: repeated moves and UIDs.
  // what we do know:
  // - in order to know about a message, we must have a current UID of the
  //   message on the server where it currently lives.
  // what we could do:
  // - have successor move operations moot/replace their predecessor.  So a
  //   move from A to B, and then from B to C will just become a move from A to
  //   C from the perspective of the online op that will eventually be run.  We
  //   could potentially build this on top of a renaming strategy.  So if we
  //   move z-in-A to z-in-B, and then change a tag on z-in-B, and then move
  //   z-in-B to z-in-C, renaming and consolidatin would make this a move of
  //   z-in-A to z-in-C followed by a tag change on z-in-C.
  // - produce micro-IMAP-ops as a byproduct of our local actions that are
  //   stored on the operation.  So in the A/move to B/tag/move to C case above,
  //   we would not consolidate anything, just produce a transaction journal.
  //   The A-move-to-B case would be covered by serializing the information
  //   for the IMAP COPY and deletion.  In the UIDPLUS case, we have an
  //   automatic knowledge of the resulting new target UID; in the non-UIDPLUS
  //   case we can open the target folder and find out the new UID as part of
  //   the micro-op.  The question here is then how we chain these various
  //   results together in the multi-move case, or when we write the result to
  //   the target:
  //   - maintain an output value map for the operations.  When there is just
  //     the one move, the output for the UID for each move is the current
  //     header name of the message, which we will load and write the value
  //     into.  When there are multiple moves, the output map is adjusted and
  //     used to indicate that we should stash the UID in quasi-persistent
  //     storage for a subsequent move operation.  (This could be thought of
  //     as similar to the renaming logic, but explicit.)


  local_do_move: function(op, doneCallback, targetFolderId) {
    // create a scratch field to store the guid's for check purposes
    op.guids = {};

    var stateDelta = this._stateDelta;
    var perSourceFolder = function perSourceFolder(ignoredConn, targetStorage) {
      this._partitionAndAccessFoldersSequentially(
        op.messages, false,
        function perFolder(ignoredConn, sourceStorage, headers, perFolderDone) {
          // -- get the body for the next header (or be done)
          function processNext() {
            if (iNextHeader >= headers.length) {
              perFolderDone();
              return;
            }
            header = headers[iNextHeader++];
            sourceStorage.getMessageBody(header.suid, header.date,
                                         gotBody_nowDelete);
          }
          // -- delete the header and body from the source
          function gotBody_nowDelete(_body) {
            body = _body;
            sourceStorage.deleteMessageHeaderAndBody(header, deleted_nowAdd);
          }
          // -- add the header/body to the target folder
          function deleted_nowAdd() {
            var sourceSuid = header.suid;

            // - update id fields
            header.id = targetStorage._issueNewHeaderId();
            header.suid = targetStorage.folderId + '/' + header.id;
            header.srvid = null;

            stateDelta.moveMap[sourceSuid] = header.suid;

            addWait = 2;
            targetStorage.addMessageHeader(header, added);
            targetStorage.addMessageBody(header, body, added);
          }
          function added() {
            if (--addWait !== 0)
              return;
            processNext();
          }
          var iNextHeader = 0, header = null, body = null, addWait = 0;
        },
        doneCallback,
        null,
        false,
        'local move source');
    }.bind(this);
    this._accessFolderForMutation(
      targetFolderId || op.targetFolder, false,
      perSourceFolder, null, 'local move target');
  },

  do_move: function(op, doneCallback) {
    var stateDelta = this._stateDelta;
    // resolve the target folder again
    this._accessFolderForMutation(
      op.targetFolder, true,
      function gotTargetConn(targetConn, targetStorage) {
        var uidnext = targetConn.box._uidnext;

      this._partitionAndAccessFoldersSequentially(
        op.messages, true,
        function perFolder(folderConn, sourceStorage, suids, serverIds,
                           perFolderDone){
          // - copies are done, find the UIDs
          // XXX process UIDPLUS output when present, avoiding this step.
          /*
           * Figuring out the new UIDs.  IMAP's semantics make this
           * reasonably easy for us.
           *
           */
          function copiedMessages_findNewUIDs() {

          }
          function foundUIDs_deleteOriginals() {
            folderConn._conn.addFlags(serverIds, ['\\Deleted'], deleted);

            stateDelta.serverIdMap[suid] = newUid;
          }
          folderConn._conn.copy(serverIds, targetFolderMeta.path,
                                copiedMessages_deleteOriginals);

          var iNextHeader = 0, header = null, body = null, addWait = 0;
        },
        doneCallback,
        null,
        false,
        'local move source');
      // get a connection in the source folder, uid validity is asserted
      // issue the (potentially bulk) copy
      // wait for copy success
      // mark the source messages deleted
    }.bind(this),
    function targetFolderDead() {
    },
    'move target');
  },

  /**
   * Verify the move results.  This is most easily/efficiently done, from our
   * perspective, by checking based on message-id's.  Another approach would be
   * to leverage the persistence of the
   *
   */
  check_move: function(op, callback) {
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

  check_copy: function(op, callback) {
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

    var gotFolderConn = function gotFolderConn(_folderConn) {
      if (!_folderConn) {
        done('unknown');
        return;
      }
      folderConn = _folderConn;
      if (folderConn._conn.hasCapability('MULTIAPPEND'))
        multiappend();
      else
        append();
    };
    var deadConn = function deadConn() {
      callback('aborted-retry');
    };
    var multiappend = function multiappend() {
      iNextMessage = op.messages.length;
      folderConn._conn.multiappend(op.messages, appended);
    };
    var append = function append() {
      var message = op.messages[iNextMessage++];
      folderConn._conn.append(
        message.messageText,
        message, // (it will ignore messageText)
        appended);
    };
    var appended = function appended(err) {
      if (err) {
        console.error('failure appending message', err);
        done('unknown');
        return;
      }
      if (iNextMessage < op.messages.length)
        append();
      else
        done(null);
    };
    var done = function done(errString) {
      if (folderConn)
        folderConn = null;
      callback(errString);
    };

    this._accessFolderForMutation(op.folderId, true, gotFolderConn, deadConn,
                                  'append');
  },

  /**
   * Check if the message ended up in the folder.
   */
  check_append: function(op, callback) {
    // XXX search on the message-id in the folder to verify its presence.
  },

  //////////////////////////////////////////////////////////////////////////////
  // createFolder: Create a folder

  local_do_createFolder: function(op) {
    // we never locally perform this operation.
  },

  do_createFolder: function(op, callback) {
    var path, delim;
    if (op.parentFolderId) {
      if (!this.account._folderInfos.hasOwnProperty(op.parentFolderId))
        throw new Error("No such folder: " + op.parentFolderId);
      var parentFolder = this._folderInfos[op.parentFolderId];
      delim = parentFolder.path;
      path = parentFolder.path + delim;
    }
    else {
      path = '';
      delim = this.account.meta.rootDelim;
    }
    if (typeof(op.folderName) === 'string')
      path += op.folderName;
    else
      path += op.folderName.join(delim);
    if (op.containOnlyOtherFolders)
      path += delim;

    var rawConn = null, self = this;
    function gotConn(conn) {
      // create the box
      rawConn = conn;
      rawConn.addBox(path, addBoxCallback);
    }
    function addBoxCallback(err) {
      if (err) {
        console.error('Error creating box:', err);
        // XXX implement the already-exists check...
        done('unknown');
        return;
      }
      // Do a list on the folder so that we get the right attributes and any
      // magical case normalization performed by the server gets observed by
      // us.
      rawConn.getBoxes('', path, gotBoxes);
    }
    function gotBoxes(err, boxesRoot) {
      if (err) {
        console.error('Error looking up box:', err);
        done('unknown');
        return;
      }
      // We need to re-derive the path.  The hierarchy will only be that
      // required for our new folder, so we traverse all children and create
      // the leaf-node when we see it.
      var folderMeta = null;
      function walkBoxes(boxLevel, pathSoFar, pathDepth) {
        for (var boxName in boxLevel) {
          var box = boxLevel[boxName],
              boxPath = pathSoFar ? (pathSoFar + boxName) : boxName;
          if (box.children) {
            walkBoxes(box.children, boxPath + box.delim, pathDepth + 1);
          }
          else {
            var type = self.account._determineFolderType(box, boxPath);
            folderMeta = self.account._learnAboutFolder(boxName, boxPath, type,
                                                        box.delim, pathDepth);
          }
        }
      }
      walkBoxes(boxesRoot, '', 0);
      if (folderMeta)
        done(null, folderMeta);
      else
        done('unknown');
    }
    function done(errString, folderMeta) {
      if (rawConn)
        rawConn = null;
      if (callback)
        callback(errString, folderMeta);
    }
    this._acquireConnWithoutFolder('createFolder', gotConn);
  }

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
