/**
 * Mix-ins for account job functionality where the code is reused.
 **/

define(
  [
    './worker-router',
    './util',
    'exports'
  ],
  function(
    $router,
    $util,
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
                                    header, next);
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
            // localdraft messages aren't real, and so must not be moved and
            // are only eligible for nuke deletion.
            sourceStorage.folderMeta.type === 'localdrafts') {
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
        targetStorage.addMessageHeader(header, added);
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
      doneCallback(null, null, true);
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
  var pendingStorageWrites = 0, downloadErr = null;
  /**
   * Save an attachment to device storage, making the filename unique if we
   * encounter a collision.
   */
  function saveToStorage(blob, storage, filename, partInfo, isRetry) {
    pendingStorageWrites++;

    var callback = function(success, error, savedFilename) {
      if (success) {
        self._LOG.savedAttachment(storage, blob.type, blob.size);
        console.log('saved attachment to', storage, savedFilename, 'type:', blob.type);
        partInfo.file = [storage, savedFilename];
        if (--pendingStorageWrites === 0)
          done();
      } else {
        self._LOG.saveFailure(storage, blob.type, error, filename);
        console.warn('failed to save attachment to', storage, filename,
                     'type:', blob.type);
        pendingStorageWrites--;
        // if we failed to unique the file after appending junk, just give up
        if (isRetry) {
          if (pendingStorageWrites === 0)
            done();
          return;
        }
        // retry by appending a super huge timestamp to the file before its
        // extension.
        var idxLastPeriod = filename.lastIndexOf('.');
        if (idxLastPeriod === -1)
          idxLastPeriod = filename.length;
        filename = filename.substring(0, idxLastPeriod) + '-' + Date.now() +
                    filename.substring(idxLastPeriod);
        saveToStorage(blob, storage, filename, partInfo, true);
      }
    };
    sendMessage('save', [storage, blob, filename], callback);
  }
  var gotParts = function gotParts(err, bodyBlobs) {
    if (bodyBlobs.length !== partsToDownload.length) {
      callback(err, null, false);
      return;
    }
    downloadErr = err;
    for (var i = 0; i < partsToDownload.length; i++) {
      // Because we should be under a mutex, this part should still be the
      // live representation and we can mutate it.
      var partInfo = partsToDownload[i],
          blob = bodyBlobs[i],
          storeTo = storePartsTo[i];

      if (blob) {
        partInfo.sizeEstimate = blob.size;
        partInfo.type = blob.type;
        if (storeTo === 'idb')
          partInfo.file = blob;
        else
          saveToStorage(blob, storeTo, partInfo.name, partInfo);
      }
    }
    if (!pendingStorageWrites)
      done();
  };

  function done() {
    folderStorage.updateMessageBody(header, bodyInfo, function() {
      callback(downloadErr, bodyInfo, true);
    });
  };

  self._accessFolderForMutation(folderId, true, gotConn, deadConn,
                                'download');
};

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

    folderConn.downloadBodyReps(header, onDownloadReps);
  };

  var onDownloadReps = function onDownloadReps(err, bodyInfo) {
    if (err) {
      console.error('Error downloading reps', err);
      // fail we cannot download for some reason?
      callback('unknown');
      return;
    }

    // success
    callback(null, bodyInfo, true);
  };

  self._accessFolderForMutation(folderId, true, gotConn, deadConn,
                                'downloadBodyReps');
};

exports.local_do_downloadBodyReps = function(op, callback) {
  callback(null);
};


exports.local_do_saveDraft = function(op, callback) {
  var localDraftsFolder = this.account.getFirstFolderWithType('localdrafts');
  if (!localDraftsFolder) {
    callback('moot');
    return;
  }
  var self = this;
  this._accessFolderForMutation(
    localDraftsFolder.id, /* needConn*/ false,
    function(nullFolderConn, folderStorage) {
      function next() {
        if (--waitingFor === 0) {
          callback(
            null,
            { suid: header.suid, date: header.date },
            /* save account */ true);
        }
      }
      var waitingFor = 2;

      var header = op.header, body = op.body;
      // fill-in header id's
      header.id = folderStorage._issueNewHeaderId();
      header.suid = folderStorage.folderId + '/' + header.id;

      // If there already was a draft saved, delete it.
      // Note that ordering of the removal and the addition doesn't really
      // matter here because of our use of transactions.
      if (op.existingNamer) {
        waitingFor++;
        folderStorage.deleteMessageHeaderAndBody(
          op.existingNamer.suid, op.existingNamer.date, next);
      }

      folderStorage.addMessageHeader(header, next);
      folderStorage.addMessageBody(header, body, next);
    },
    /* no conn => no deathback required */ null,
    'saveDraft');
};

exports.do_saveDraft = function(op, callback) {
  // there is no server component for this
  callback(null);
};
exports.check_saveDraft = function(op, callback) {
  callback(null, 'moot');
};
exports.local_undo_saveDraft = function(op, callback) {
  callback(null);
};
exports.undo_saveDraft = function(op, callback) {
  callback(null);
};

exports.local_do_deleteDraft = function(op, callback) {
  var localDraftsFolder = this.account.getFirstFolderWithType('localdrafts');
  if (!localDraftsFolder) {
    callback('moot');
    return;
  }
  var self = this;
  this._accessFolderForMutation(
    localDraftsFolder.id, /* needConn*/ false,
    function(nullFolderConn, folderStorage) {
      folderStorage.deleteMessageHeaderAndBody(
        op.messageNamer.suid, op.messageNamer.date,
        function() {
          callback(null, null, /* save account */ true);
        });
    },
    /* no conn => no deathback required */ null,
    'deleteDraft');
};

exports.do_deleteDraft = function(op, callback) {
  // there is no server component for this
  callback(null);
};
exports.check_deleteDraft = function(op, callback) {
  callback(null, 'moot');
};
exports.local_undo_deleteDraft = function(op, callback) {
  callback(null);
};
exports.undo_deleteDraft = function(op, callback) {
  callback(null);
};


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
