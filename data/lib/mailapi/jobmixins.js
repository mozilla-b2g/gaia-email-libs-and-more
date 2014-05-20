/**
 * Mix-ins for account job functionality where the code is reused.
 **/

define(
  [
    './worker-router',
    './util',
    './allback',
    './wakelocks',
    './date',
    './syncbase',
    'exports'
  ],
  function(
    $router,
    $util,
    $allback,
    $wakelocks,
    $date,
    $sync,
    exports
  ) {

var sendMessage = $router.registerCallbackType('devicestorage');

exports.local_do_modtags = function(op, doneCallback, undo) {
  var addTags = undo ? op.removeTags : op.addTags,
      removeTags = undo ? op.addTags : op.removeTags;
  this._partitionAndAccessFoldersSequentially(
    op.messages,
    false,
    function perFolder(ignoredConn, storage, headers, namers, callWhenDone) {
      var waitingOn = headers.length;
      function next() {
        if (--waitingOn === 0)
          callWhenDone();
      }
      for (var iHeader = 0; iHeader < headers.length; iHeader++) {
        var header = headers[iHeader];
        var iTag, tag, existing, modified = false;
        if (addTags) {
          for (iTag = 0; iTag < addTags.length; iTag++) {
            tag = addTags[iTag];
            // The list should be small enough that native stuff is better
            // than JS bsearch.
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
        storage.updateMessageHeader(header.date, header.id, false,
                                    header, /* body hint */ null, next);
      }
    },
    function() {
      doneCallback(null, null, true);
    },
    null, // connection loss does not happen for local-only ops
    undo,
    'modtags');
};

exports.local_undo_modtags = function(op, callback) {
  // Undoing is just a question of flipping the add and remove lists.
  return this.local_do_modtags(op, callback, true);
};


exports.local_do_move = function(op, doneCallback, targetFolderId) {
  // create a scratch field to store the guid's for check purposes
  op.guids = {};
  var nukeServerIds = !this.resilientServerIds;

  var stateDelta = this._stateDelta, addWait = 0, self = this;
  if (!stateDelta.moveMap)
    stateDelta.moveMap = {};
  if (!stateDelta.serverIdMap)
    stateDelta.serverIdMap = {};
  if (!targetFolderId)
    targetFolderId = op.targetFolder;

  this._partitionAndAccessFoldersSequentially(
    op.messages, false,
    function perFolder(ignoredConn, sourceStorage, headers, namers,
                       perFolderDone) {
      // -- open the target folder for processing
      function targetOpened_nowProcess(ignoredConn, _targetStorage) {
        targetStorage = _targetStorage;
        processNext();
      }
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

        // We need an entry in the server id map if we are moving/deleting it.
        // We don't need this if we're moving a message to the folder it's
        // already in, but it doesn't hurt anything.
        if (header.srvid)
          stateDelta.serverIdMap[header.suid] = header.srvid;

        if (sourceStorage === targetStorage ||
            // localdraft messages aren't real, and so must not be
            // moved and are only eligible for nuke deletion. But they
            // _can_ be moved to the outbox, and vice versa!
            (sourceStorage.folderMeta.type === 'localdrafts' &&
             targetStorage.folderMeta.type !== 'outbox') ||
            (sourceStorage.folderMeta.type === 'outbox' &&
             targetStorage.folderMeta.type !== 'localdrafts')) {
          if (op.type === 'move') {
            // A move from a folder to itself is a no-op.
            processNext();
          }
          else { // op.type === 'delete'
            // If the op is a delete and the source and destination folders
            // match, we're deleting from trash, so just perma-delete it.
            sourceStorage.deleteMessageHeaderAndBodyUsingHeader(
              header, processNext);
          }
        }
        else {
          sourceStorage.deleteMessageHeaderAndBodyUsingHeader(
            header, deleted_nowAdd);
        }
      }
      // -- add the header/body to the target folder
      function deleted_nowAdd() {
        var sourceSuid = header.suid;

        // - update id fields
        header.id = targetStorage._issueNewHeaderId();
        header.suid = targetStorage.folderId + '/' + header.id;
        if (nukeServerIds)
          header.srvid = null;

        stateDelta.moveMap[sourceSuid] = header.suid;
        addWait = 2;
        targetStorage.addMessageHeader(header, body, added);
        targetStorage.addMessageBody(header, body, added);
      }
      function added() {
        if (--addWait !== 0)
          return;
        processNext();
      }
      var iNextHeader = 0, targetStorage = null, header = null, body = null,
          addWait = 0;

      // If the source folder and the target folder are the same, don't try
      // to access the target folder!
      if (sourceStorage.folderId === targetFolderId) {
        targetStorage = sourceStorage;
        processNext();
      }
      else {
        self._accessFolderForMutation(targetFolderId, false,
                                      targetOpened_nowProcess, null,
                                      'local move target');
      }
    },
    function() {
      doneCallback(null, stateDelta.moveMap, true);
    },
    null, // connection loss does not happen for local-only ops
    false,
    'local move source');
};

// XXX implement!
exports.local_undo_move = function(op, doneCallback, targetFolderId) {
  doneCallback(null);
};

exports.local_do_delete = function(op, doneCallback) {
  var trashFolder = this.account.getFirstFolderWithType('trash');
  if (!trashFolder) {
    this.account.ensureEssentialFolders();
    doneCallback('defer');
    return;
  }
  this.local_do_move(op, doneCallback, trashFolder.id);
};

exports.local_undo_delete = function(op, doneCallback) {
  var trashFolder = this.account.getFirstFolderWithType('trash');
  if (!trashFolder) {
    // the absence of the trash folder when it must have previously existed is
    // confusing.
    doneCallback('unknown');
    return;
  }
  this.local_undo_move(op, doneCallback, trashFolder.id);
};

exports.do_download = function(op, callback) {
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
  var partsToDownload = [], storePartsTo = [], header, bodyInfo, uid;
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
      storePartsTo.push('idb');
    }
    for (i = 0; i < op.attachmentIndices.length; i++) {
      partInfo = bodyInfo.attachments[op.attachmentIndices[i]];
      if (partInfo.file)
        continue;
      partsToDownload.push(partInfo);
      // right now all attachments go in sdcard
      storePartsTo.push('sdcard');
    }

    folderConn.downloadMessageAttachments(uid, partsToDownload, gotParts);
  };

  var downloadErr = null;
  var gotParts = function gotParts(err, bodyBlobs) {
    if (bodyBlobs.length !== partsToDownload.length) {
      callback(err, null, false);
      return;
    }
    downloadErr = err;
    var pendingCbs = 1;
    function next() {
      if (!--pendingCbs) {
        done();
      }
    }

    for (var i = 0; i < partsToDownload.length; i++) {
      // Because we should be under a mutex, this part should still be the
      // live representation and we can mutate it.
      var partInfo = partsToDownload[i],
          blob = bodyBlobs[i],
          storeTo = storePartsTo[i];

      if (blob) {
        partInfo.sizeEstimate = blob.size;
        partInfo.type = blob.type;
        if (storeTo === 'idb') {
          partInfo.file = blob;
        } else {
          pendingCbs++;
          saveToDeviceStorage(
              self._LOG, blob, storeTo, partInfo.name, partInfo, next);
        }
      }
    }

    next();
  };
  function done() {
    folderStorage.updateMessageBody(
      header, bodyInfo,
      { flushBecause: 'blobs' },
      {
        changeDetails: {
          attachments: op.attachmentIndices
        }
      },
      function() {
        callback(downloadErr, null, true);
      });
  };

  self._accessFolderForMutation(folderId, true, gotConn, deadConn,
                                'download');
}

/**
 * Save an attachment to device storage, making the filename unique if we
 * encounter a collision.
 */
var saveToDeviceStorage = exports.saveToDeviceStorage =
function(_LOG, blob, storeTo, filename, partInfo, cb, isRetry) {
  var self = this;
  var callback = function(success, error, savedFilename) {
    if (success) {
      _LOG.savedAttachment(storeTo, blob.type, blob.size);
      console.log('saved attachment to', storeTo, savedFilename,
                  'type:', blob.type);
      partInfo.file = [storeTo, savedFilename];
      cb();
    } else {
      _LOG.saveFailure(storeTo, blob.type, error, filename);
      console.warn('failed to save attachment to', storeTo, filename,
                   'type:', blob.type);
      // if we failed to unique the file after appending junk, just give up
      if (isRetry) {
        cb(error);
        return;
      }
      // retry by appending a super huge timestamp to the file before its
      // extension.
      var idxLastPeriod = filename.lastIndexOf('.');
      if (idxLastPeriod === -1)
        idxLastPeriod = filename.length;
      filename = filename.substring(0, idxLastPeriod) + '-' + Date.now() +
        filename.substring(idxLastPeriod);
      saveToDeviceStorage(_LOG, blob, storeTo, filename, partInfo, cb, true);
    }
  };
  sendMessage('save', [storeTo, blob, filename], callback);
}

exports.local_do_download = function(op, callback) {
  // Downloads are inherently online operations.
  callback(null);
};

exports.check_download = function(op, callback) {
  // If we downloaded the file and persisted it successfully, this job would be
  // marked done because of the atomicity guarantee on our commits.
  callback(null, 'coherent-notyet');
};
exports.local_undo_download = function(op, callback) {
  callback(null);
};
exports.undo_download = function(op, callback) {
  callback(null);
};


exports.local_do_downloadBodies = function(op, callback) {
  callback(null);
};

exports.do_downloadBodies = function(op, callback) {
  var aggrErr, totalDownloaded = 0;
  this._partitionAndAccessFoldersSequentially(
    op.messages,
    true,
    function perFolder(folderConn, storage, headers, namers, callWhenDone) {
      folderConn.downloadBodies(headers, op.options, function(err, numDownloaded) {
        totalDownloaded += numDownloaded;
        if (err && !aggrErr) {
          aggrErr = err;
        }
        callWhenDone();
      });
    },
    function allDone() {
      callback(aggrErr, null,
               // save if we might have done work.
               totalDownloaded > 0);
    },
    function deadConn() {
      aggrErr = 'aborted-retry';
    },
    false, // reverse?
    'downloadBodies',
    true // require headers
  );
};

exports.check_downloadBodies = function(op, callback) {
  // If we had downloaded the bodies and persisted them successfully, this job
  // would be marked done because of the atomicity guarantee on our commits.  It
  // is possible this request might only be partially serviced, in which case we
  // will avoid redundant body fetches, but redundant folder selection is
  // possible if this request spans multiple folders.
  callback(null, 'coherent-notyet');
};

exports.check_downloadBodyReps = function(op, callback) {
  // If we downloaded all of the body parts and persisted them successfully,
  // this job would be marked done because of the atomicity guarantee on our
  // commits.  But it's not, so there's more to do.
  callback(null, 'coherent-notyet');
};

exports.do_downloadBodyReps = function(op, callback) {
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

  var gotHeader = function gotHeader(header) {
    // header may have been deleted by the time we get here...
    if (!header) {
      callback();
      return;
    }

    // Check to see if we've already downloaded the bodyReps for this
    // message. If so, no need to even try to fetch them again. This
    // allows us to enforce an idempotency guarantee regarding how
    // many times body change notifications will be fired.
    folderStorage.getMessageBody(header.suid, header.date,
                                         function(body) {
      if (!body.bodyReps.every(function(rep) { return rep.isDownloaded; })) {
        folderConn.downloadBodyReps(header, onDownloadReps);
      } else {
        // passing flushed = true because we don't need to save anything
        onDownloadReps(null, body, /* flushed = */ true);
      }
    });
  };

  var onDownloadReps = function onDownloadReps(err, bodyInfo, flushed) {
    if (err) {
      console.error('Error downloading reps', err);
      // fail we cannot download for some reason?
      callback('unknown');
      return;
    }

    // Since we downloaded something, we do want to save what we downloaded,
    // but only if the downloader didn't already force a save while flushing.
    var save = !flushed;
    callback(null, bodyInfo, save);
  };

  self._accessFolderForMutation(folderId, true, gotConn, deadConn,
                                'downloadBodyReps');
};

exports.local_do_downloadBodyReps = function(op, callback) {
  callback(null);
};


////////////////////////////////////////////////////////////////////////////////
// sendOutboxMessages

exports.local_do_sendOutboxMessages = function(op, callback) {
  callback(null); // there is no local component for this
};

// The first invocation of sendOutboxMessages (after each startup)
// must try to send _all_ sendable outbox messages, even if some were
// marked as being in the process of sending. For instance, if the app
// dies during outbox sending, but we never finished sending the
// message, we still need to try sending again.
//
// This map keeps track of runtime state: Whenever any account runs
// sendOutboxMessages for the first time, we'll store
//
//     { (accountId): true }
//
// to indicate that we've already done this "full" pass. Subsequent
// sendOutboxMessages jobs will only try to synchronize messages
// already marked as "not sending yet", since we assume that we'll
// clean up state properly as long as the app itself doesn't crash.
var accountOutboxClearedMap = {};

var accountOutboxDisabledTemporarilyMap = {};

/**
 * Attempt to send any messages in the Outbox which are not currently
 * being sent. We set `header.sendStatus` to an object representing
 * the current state of the send operation. If the send fails, we'll
 * remove the flag and indicate that there was an error sending,
 * unless the app crashes, in which case we'll try to resend upon
 * startup again (see `ignoreSendingFlag` below).
 *
 * Callback is called with the number of messages successfully sent.
 */
exports.do_sendOutboxMessages = function(op, callback) {
  var outboxFolder = this.account.getFirstFolderWithType('outbox');
  if (!outboxFolder) {
    callback('moot'); // This shouldn't happen, we should always have an outbox.
    return;
  }

  // If we temporarily paused outbox syncing, don't do anything.
  if (accountOutboxDisabledTemporarilyMap[this.account.id]) {
    console.log('outbox: Outbox syncing temporarily disabled; not syncing.');
    callback(null);
    return;
  }

  var ignoreSendingFlag = false;
  if (!accountOutboxClearedMap[this.account.id]) {
    console.log('outbox: This is the first outbox sync for this account.');
    accountOutboxClearedMap[this.account.id] = true;
    ignoreSendingFlag = true;
  }

  var self = this;

  // Hold both a CPU and WiFi wake lock for the duration of the send
  // operation. We'll pass this in to the Composer instance for each
  // message, so that the SMTP/ActiveSync sending process can renew
  // the wake lock from time to time as the send continues.
  var wakeLock = new $wakelocks.SmartWakeLock({
    locks: ['cpu', 'wifi']
  });

  this._accessFolderForMutation(
    outboxFolder.id, /* needConn = */ false,
    function(nullFolderConn, folderStorage) {
      require(['mailapi/drafts/composer'], function ($composer) {
        folderStorage.getAllMessagesInImapDateRange(0, null, function(headers) {
          var totalSending = 0;
          var totalSent = 0;
          var latch = $allback.latch();

          // Update the sendStatus info for a given message,
          // overriding only the sendStatus keys you pass in.
          function updateSendStatus(composer, header, status, cb) {
            for (var key in status) {
              header.sendStatus[key] = status[key];
            }
            folderStorage.updateMessageHeader(
              header.date, header.id, /* partOfSync */ false, header,
              /* body hint */ null, function() {
                // If this was initiated from a compose window, the
                // first message in the outbox will have the most
                // recent timestamp, and be the one the user is
                // interested in receiving notifications about.
                if (op.sendingMessage && header.suid === headers[0].suid) {
                  status.accountId = self.account.id;
                  status.suid = header.suid;
                  // For tests:
                  status.messageId = composer.messageId;
                  status.sentDate = composer.sentDate;
                  self.account.universe.__notifyBackgroundSendStatus(status);
                }
                cb && cb();
              });
          }

          // Send all messages in parallel to reduce the amount of
          // time the radio remains on.
          headers.forEach(function(header) {
            header.sendStatus = header.sendStatus || {};
            if ((header.sendStatus.state === 'sending') && !ignoreSendingFlag) {
              return; // It's already sending, nothing to do for this message.
            }

            totalSending++;
            var sendDone = latch.defer();

            folderStorage.getMessage(header.suid, header.date, function(msg) {
              header = msg.header; // for consistency

              // If we're dealing with a composite account, this is
              // only the sending side, so retrieve the composite
              // account.
              var account = self.account.universe.getAccountForMessageSuid(
                header.suid);
              var composer = new $composer.Composer(msg, account,
                                                    account.identities[0]);

              composer.setSmartWakeLock(wakeLock);

              updateSendStatus(composer, header, {
                state: 'sending',
                err: null,
                badAddresses: null
              }, function() {
                account.sendMessage(composer, function(err, badAddresses) {
                  if (err) {
                    console.log('outbox: Message failed to send (' + err + ')');

                    updateSendStatus(composer, header, {
                      state: 'error',
                      err: err,
                      badAddresses: badAddresses,
                      sendFailures: (header.sendStatus.sendFailures || 0) + 1
                    }, sendDone);
                  } else {
                    console.log('outbox: Message sent; deleting from outbox.');
                    totalSent++;
                    // We still run the update header logic, so that we
                    // don't double-send if the delete doesn't go
                    // through, and for code clarity.
                    updateSendStatus(composer, header, {
                      state: 'success',
                      err: null,
                      badAddresses: null
                    }, function() {
                      folderStorage.deleteMessageHeaderAndBodyUsingHeader(
                        msg.header, sendDone);
                    });
                  }
                });
              });
            });
          });
          console.log('outbox: Sending', totalSending, 'messages;',
                      (headers.length - totalSending), 'already being sent.');

          latch.then(function() {
            wakeLock.unlock('all messages sent');
            console.log('outbox: Done. Sent', totalSent, 'messages.');
            folderStorage.markSyncRange(
              $sync.OLDEST_SYNC_DATE, null, 'XXX', $date.NOW());
            callback(null, totalSent);
          });
        });
      });
    },
    /* no conn => no deathback required */ null,
    'sendOutboxMessages');
};

exports.check_sendOutboxMessages = function(op, callback) {
  callback(null, 'moot');
};
exports.local_undo_sendOutboxMessages = function(op, callback) {
  callback(null);
};
exports.undo_sendOutboxMessages = function(op, callback) {
  callback(null);
};

exports.local_do_setOutboxSyncEnabled = function(op, callback) {
  accountOutboxDisabledTemporarilyMap[this.account.id] = !op.outboxSyncEnabled;
  callback(null); // there is no local component for this
};

////////////////////////////////////////////////////////////////


exports.postJobCleanup = function(passed) {
  if (passed) {
    var deltaMap, fullMap;
    // - apply updates to the serverIdMap map
    if (this._stateDelta.serverIdMap) {
      deltaMap = this._stateDelta.serverIdMap;
      fullMap = this._state.suidToServerId;
      for (var suid in deltaMap) {
        var srvid = deltaMap[suid];
        if (srvid === null)
          delete fullMap[suid];
        else
          fullMap[suid] = srvid;
      }
    }
    // - apply updates to the move map
    if (this._stateDelta.moveMap) {
      deltaMap = this._stateDelta.moveMap;
      fullMap = this._state.moveMap;
      for (var oldSuid in deltaMap) {
        var newSuid = deltaMap[oldSuid];
        fullMap[oldSuid] = newSuid;
      }
    }
  }

  for (var i = 0; i < this._heldMutexReleasers.length; i++) {
    this._heldMutexReleasers[i]();
  }
  this._heldMutexReleasers = [];

  this._stateDelta.serverIdMap = null;
  this._stateDelta.moveMap = null;
};

exports.allJobsDone =  function() {
  this._state.suidToServerId = {};
  this._state.moveMap = {};
};

/**
 * Partition messages identified by namers by folder, then invoke the callback
 * once per folder, passing in the loaded message header objects for each
 * folder.
 *
 * This method will filter out removed headers (which would otherwise be null).
 * Its possible that entire folders will be skipped if no headers requested are
 * now present.
 *
 * Connection loss by default causes this method to stop trying to traverse
 * folders, calling callOnConnLoss and callWhenDone in that order.  If you want
 * to do something more clever, extend this method so that you can return a
 * sentinel value or promise or something and do your clever thing.
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
 *       @param[headersOrServerIds @oneof[
 *         @listof[HeaderInfo]
 *         @listof[ServerID]]
 *       ]
 *       @param[messageNamers @listof[MessageNamer]]
 *       @param[callWhenDoneWithFolder Function]
 *     ]
 *   ]]
 *   @param[callWhenDone @func[
 *     @args[err @oneof[null 'connection-list']]
 *   ]]{
 *     The function to invoke when all of the folders have been processed or the
 *     connection has been lost and we're giving up.  This will be invoked after
 *     `callOnConnLoss` in the event of a conncetion loss.
 *   }
 *   @param[callOnConnLoss Function]{
 *     This function we invoke when we lose a connection.  Traditionally, you would
 *     use this to flag an error in your function that you would then return when
 *     we invoke `callWhenDone`.  Then your check function will be invoked and you
 *     can laboriously check what actually happened on the server, etc.
 *   }
 *   @param[reverse #:optional Boolean]{
 *     Should we walk the partitions in reverse order?
 *   }
 *   @param[label String]{
 *     The label to use to name the usage of the folder connection.
 *   }
 *   @param[requireHeaders Boolean]{
 *     True if connection & headers are needed.
 *   }
 * ]
 */
exports._partitionAndAccessFoldersSequentially = function(
    allMessageNamers,
    needConn,
    callInFolder,
    callWhenDone,
    callOnConnLoss,
    reverse,
    label,
    requireHeaders) {
  var partitions = $util.partitionMessagesByFolderId(allMessageNamers);
  var folderConn, storage, self = this,
      folderId = null, folderMessageNamers = null, serverIds = null,
      iNextPartition = 0, curPartition = null, modsToGo = 0,
      // Set to true immediately before calling callWhenDone; causes us to
      // immediately bail out of any of our callbacks in order to avoid
      // continuing beyond the point when we should have stopped.
      terminated = false;

  if (reverse)
    partitions.reverse();

  var openNextFolder = function openNextFolder() {
    if (terminated)
      return;
    if (iNextPartition >= partitions.length) {
      terminated = true;
      callWhenDone(null);
      return;
    }
    // Cleanup the last folder (if there was one)
    if (iNextPartition) {
      folderConn = null;
      // The folder's mutex should be last; if the callee acquired any
      // additional mutexes in the last round, it should have freed it then
      // too.
      var releaser = self._heldMutexReleasers.pop();
      if (releaser)
        releaser();
      folderConn = null;
    }

    curPartition = partitions[iNextPartition++];
    folderMessageNamers = curPartition.messages;
    serverIds = null;
    if (curPartition.folderId !== folderId) {
      folderId = curPartition.folderId;
      self._accessFolderForMutation(folderId, needConn, gotFolderConn,
                                    connDied, label);
    }
  };
  var connDied = function connDied() {
    if (terminated)
      return;
    if (callOnConnLoss) {
      try {
        callOnConnLoss();
      }
      catch (ex) {
        self._LOG.callbackErr(ex);
      }
    }
    terminated = true;
    callWhenDone('connection-lost');
  };
  var gotFolderConn = function gotFolderConn(_folderConn, _storage) {
    if (terminated)
      return;
    folderConn = _folderConn;
    storage = _storage;
    // - Get headers or resolve current server id from name map
    if (needConn && !requireHeaders) {
      var neededHeaders = [],
          suidToServerId = self._state.suidToServerId;
      serverIds = [];
      for (var i = 0; i < folderMessageNamers.length; i++) {
        var namer = folderMessageNamers[i];
        var srvid = suidToServerId[namer.suid];
        if (srvid) {
          serverIds.push(srvid);
        }
        else {
          serverIds.push(null);
          neededHeaders.push(namer);
        }
      }

      if (!neededHeaders.length) {
        try {
          callInFolder(folderConn, storage, serverIds, folderMessageNamers,
                       openNextFolder);
        }
        catch (ex) {
          console.error('PAAFS error:', ex, '\n', ex.stack);
        }
      }
      else {
        storage.getMessageHeaders(neededHeaders, gotNeededHeaders);
      }
    }
    else {
      storage.getMessageHeaders(folderMessageNamers, gotHeaders);
    }
  };
  var gotNeededHeaders = function gotNeededHeaders(headers) {
    if (terminated)
      return;
    var iNextServerId = serverIds.indexOf(null);
    for (var i = 0; i < headers.length; i++) {
      var header = headers[i];
      // It's possible that by the time this job actually gets a chance to run
      // that the header is no longer in the folder.  This is rare but not
      // particularly exceptional.
      if (header) {
        var srvid = header.srvid;
        serverIds[iNextServerId] = srvid;
        // A header that exists but does not have a server id is exceptional and
        // bad, although logic should handle it because of the above dead-header
        // case.  suidToServerId should really have provided this information to
        // us.
        if (!srvid)
          console.warn('Header', headers[i].suid, 'missing server id in job!');
      }
      iNextServerId = serverIds.indexOf(null, iNextServerId + 1);
    }

    // its entirely possible that we need headers but there are none so we can
    // skip entering this folder as the job cannot do anything with an empty
    // header.
    if (!serverIds.length) {
      openNextFolder();
      return;
    }

    try {
      callInFolder(folderConn, storage, serverIds, folderMessageNamers,
                   openNextFolder);
    }
    catch (ex) {
      console.error('PAAFS error:', ex, '\n', ex.stack);
    }
  };
  var gotHeaders = function gotHeaders(headers) {
    if (terminated)
      return;
    // its unlikely but entirely possible that all pending headers have been
    // removed somehow between when the job was queued and now.
    if (!headers.length) {
      openNextFolder();
      return;
    }

    // Sort the headers in ascending-by-date order so that slices hear about
    // changes from oldest to newest. That way, they won't get upset about being
    // asked to expand into the past.
    headers.sort(function(a, b) { return a.date > b.date; });
    try {
      callInFolder(folderConn, storage, headers, folderMessageNamers,
                   openNextFolder);
    }
    catch (ex) {
      console.error('PAAFS error:', ex, '\n', ex.stack);
    }
  };
  openNextFolder();
};



}); // end define
