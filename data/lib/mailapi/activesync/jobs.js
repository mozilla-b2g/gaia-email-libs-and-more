define(
  [
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    '../jobmixins',
    'exports'
  ],
  function(
    $wbxml,
    $ascp,
    $activesync,
    $jobmixins,
    exports
  ) {
'use strict';

function ActiveSyncJobDriver(account, state) {
  this.account = account;
  // XXX for simplicity for now, let's assume that ActiveSync GUID's are
  // maintained across folder moves.
  this.resilientServerIds = true;
  this._heldMutexReleasers = [];
  this._state = state;
  // (we only need to use one as a proxy for initialization)
  if (!state.hasOwnProperty('suidToServerId')) {
    state.suidToServerId = {};
    state.moveMap = {};
  }

  this._stateDelta = {
    serverIdMap: null,
    moveMap: null,
  };
}
exports.ActiveSyncJobDriver = ActiveSyncJobDriver;
ActiveSyncJobDriver.prototype = {
  //////////////////////////////////////////////////////////////////////////////
  // helpers

  postJobCleanup: $jobmixins.postJobCleanup,

  allJobsDone: $jobmixins.allJobsDone,

  _accessFolderForMutation: function(folderId, needConn, callback, deathback,
                                     label) {
    var storage = this.account.getFolderStorageForFolderId(folderId),
        self = this;
    storage.runMutexed(label, function(releaseMutex) {
      self._heldMutexReleasers.push(releaseMutex);

      var syncer = storage.folderSyncer;
      if (needConn && !self.account.conn.connected) {
        // XXX will this connection automatically retry?
        self.account.conn.connect(function(err, config) {
          callback(syncer.folderConn, storage);
        });
      }
      else {
        callback(syncer.folderConn, storage);
      }
    });
  },

  _partitionAndAccessFoldersSequentially:
    $jobmixins._partitionAndAccessFoldersSequentially,

  //////////////////////////////////////////////////////////////////////////////
  // modtags

  local_do_modtags: $jobmixins.local_do_modtags,

  do_modtags: function(op, jobDoneCallback, undo) {
    // Note: this method is derived from the IMAP implementation.
    let addTags = undo ? op.removeTags : op.addTags,
        removeTags = undo ? op.addTags : op.removeTags;

    function getMark(tag) {
      if (addTags && addTags.indexOf(tag) !== -1)
        return true;
      if (removeTags && removeTags.indexOf(tag) !== -1)
        return false;
      return undefined;
    }

    let markRead = getMark('\\Seen');
    let markFlagged = getMark('\\Flagged');

    const as = $ascp.AirSync.Tags;
    const em = $ascp.Email.Tags;

    let aggrErr = null;

    this._partitionAndAccessFoldersSequentially(
      op.messages, true,
      function perFolder(folderConn, storage, serverIds, namers, callWhenDone) {
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
        folderConn.performMutation(
          function withWriter(w) {
            for (let i = 0; i < serverIds.length; i++) {
              let srvid = serverIds[i];
              // If the header is somehow an offline header, it will be null and
              // there is nothing we can really do for it.
              if (!srvid)
                continue;

              w.stag(as.Change)
                 .tag(as.ServerId, srvid)
                 .stag(as.ApplicationData);

              if (markRead !== undefined)
                w.tag(em.Read, markRead ? '1' : '0');

              if (markFlagged !== undefined)
                w.stag(em.Flag)
                   .tag(em.Status, markFlagged ? '2' : '0')
                 .etag();

                w.etag(as.ApplicationData)
             .etag(as.Change);
            }
          },
          function mutationPerformed(err) {
            if (err)
              aggrErr = err;
            callWhenDone();
          });
      },
      function allDone() {
        jobDoneCallback(aggrErr);
      },
      function deadConn() {
        aggrErr = 'aborted-retry';
      },
      /* reverse if we're undoing */ undo,
      'modtags');
  },

  check_modtags: function(op, callback) {
    callback(null, 'idempotent');
  },

  local_undo_modtags: $jobmixins.local_undo_modtags,

  undo_modtags: function(op, callback) {
    this.do_modtags(op, callback, true);
  },

  //////////////////////////////////////////////////////////////////////////////
  // move

  local_do_move: $jobmixins.local_do_move,

  do_move: function(op, jobDoneCallback) {
    /*
     * The ActiveSync command for this does not produce or consume SyncKeys.
     * As such, we don't need to acquire mutexes for the source folders for
     * synchronization correctness, although it is helpful for ordering
     * purposes and reducing confusion.
     *
     * For the target folder a similar logic exists as long as the server-issued
     * GUID's are resilient against folder moves.  However, we do require in
     * all cases that before synchronizing the target folder that we make sure
     * all move operations to the folder have completed so we message doesn't
     * disappear and then show up again. XXX we are not currently enforcing this
     * yet.
     */
    let aggrErr = null, account = this.account,
        targetFolderStorage = this.account.getFolderStorageForFolderId(
                                op.targetFolder);
    const as = $ascp.AirSync.Tags;
    const em = $ascp.Email.Tags;
    const mo = $ascp.Move.Tags;

    this._partitionAndAccessFoldersSequentially(
      op.messages, true,
      function perFolder(folderConn, storage, serverIds, namers, callWhenDone) {
        let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
        w.stag(mo.MoveItems);

        for (let i = 0; i < serverIds.length; i++) {
          let srvid = serverIds[i];
          // If the header is somehow an offline header, it will be null and
          // there is nothing we can really do for it.
          if (!srvid)
            continue;
          w.stag(mo.Move)
              .tag(mo.SrcMsgId, srvid)
              .tag(mo.SrcFldId, storage.folderMeta.serverId)
              .tag(mo.DstFldId, targetFolderStorage.folderMeta.serverId)
            .etag(mo.Move);
        }
        w.etag(mo.MoveItems);

        account.conn.postCommand(w, function(err, response) {
          if (err) {
            aggrErr = err;
            console.error('failure moving messages:', err);
          }
          callWhenDone();
        });
      },
      function allDone() {
        jobDoneCallback(aggrErr, null, true);
      },
      function deadConn() {
        aggrErr = 'aborted-retry';
      },
      false,
      'move');
  },

  check_move: function(op, jobDoneCallback) {

  },

  local_undo_move: $jobmixins.local_undo_move,

  undo_move: function(op, jobDoneCallback) {
  },

  //////////////////////////////////////////////////////////////////////////////
  // delete

  local_do_delete: $jobmixins.local_do_delete,

  do_delete: function(op, jobDoneCallback) {
    let aggrErr = null;
    const as = $ascp.AirSync.Tags;
    const em = $ascp.Email.Tags;

    this._partitionAndAccessFoldersSequentially(
      op.messages, true,
      function perFolder(folderConn, storage, serverIds, namers, callWhenDone) {
        folderConn.performMutation(
          function withWriter(w) {
            for (let i = 0; i < serverIds.length; i++) {
              let srvid = serverIds[i];
              // If the header is somehow an offline header, it will be null and
              // there is nothing we can really do for it.
              if (!srvid) {
                console.log('AS message', namers[i].suid, 'lacks srvid!');
                continue;
              }

              w.stag(as.Delete)
                  .tag(as.ServerId, srvid)
                .etag(as.Delete);
            }
          },
          function mutationPerformed(err) {
            if (err) {
              aggrErr = err;
              console.error('failure deleting messages:', err);
            }
            callWhenDone();
          });
      },
      function allDone() {
        jobDoneCallback(aggrErr, null, true);
      },
      function deadConn() {
        aggrErr = 'aborted-retry';
      },
      false,
      'delete');
  },

  check_delete: function(op, callback) {
    callback(null, 'idempotent');
  },

  local_undo_delete: $jobmixins.local_undo_delete,

  // TODO implement
  undo_delete: function(op, callback) {
    callback('moot');
  },

  //////////////////////////////////////////////////////////////////////////////
  // download

  local_do_download: function(op, ignoredCallback) {
    // Downloads are inherently online operations.
    return null;
  },

  do_download: function(op, callback) {
    let jobDriver = this;
    let lslash = message.suid.lastIndexOf('/')
    let folderId = message.suid.substring(0, lslash);
    let messageId = message.suid.substring(lslash + 1);
    let folderStorage = this.account.getFolderStorageForFolderId(folderId);

    folderStorage.getMessageBody(op.messageSuid, op.messageDate, gotBody);
    // Now that we have the body, we can know the part numbers and eliminate /
    // filter out any redundant download requests.  Issue all the fetches at
    // once.
    let partsToDownload = [], bodyInfo;
    function gotBody(_bodyInfo) {
      bodyInfo = _bodyInfo;
      for (let [,index] in Iterator(op.relPartIndices)) {
        let partInfo = bodyInfo.relatedParts[index];
        if (!partInfo.file)
          partsToDownload.push(partInfo);
      }
      for (let [,index] in Iterator(op.attachmentIndices)) {
        let partInfo = bodyInfo.attachments[index];
        if (!partInfo.file)
          partsToDownload.push(partInfo);
      }

      jobDriver._downloadAttachments(messageId, partsToDownload, gotParts);
    };

    function gotParts(err, bodyBuffers) {
      if (bodyBuffers.length !== partsToDownload.length) {
        callback(err, null, false);
        return;
      }
      for (let i = 0; i < partsToDownload.length; i++) {
        // Because we should be under a mutex, this part should still be the
        // live representation and we can mutate it.
        let partInfo = partsToDownload[i],
            buffer = bodyBuffers[i];

        partInfo.sizeEstimate = buffer.length;
        partInfo.file = new Blob([buffer],
                                 { contentType: partInfo.type });
      }
      folderStorage.updateMessageBody(op.messageSuid, op.messageDate, bodyInfo);
      callback(err, bodyInfo, true);
    };
  },

  _downloadAttachments: function(messageId, partsToDownload, callback) {
    const io = $ascp.ItemOperations.Tags;
    const asb = $ascp.AirSyncBase.Tags;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(io.ItemOperations)
       .stag(io.Fetch)
         .tag(io.Store, 'Mailbox')
         .tag(asb.FileReference, partsToDownload[0].part)
       .etag()
     .etag();

    this.account.conn.doCommand(w, function(aError, aResult) {
      console.log(aResult.dump());
      callback('badness', []);
    });
  },

  //////////////////////////////////////////////////////////////////////////////
};

}); // end define
