/**
 * Mix-ins for account job functionality where the code is reused.
 **/

define(
  [
    './util',
    'exports'
  ],
  function(
    $util,
    exports
  ) {

exports.local_do_modtags = function(op, doneCallback, undo) {
  var addTags = undo ? op.removeTags : op.addTags,
      removeTags = undo ? op.addTags : op.removeTags;
  this._partitionAndAccessFoldersSequentially(
    op.messages,
    false,
    function perFolder(ignoredConn, storage, headers, namers, callWhenDone) {
      var waitingOn = headers.length;
      function headerUpdated() {
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
                                    header, headerUpdated);
      }
    },
    function() {
      doneCallback(null, null, true);
    },
    null,
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
  const nukeServerIds = !this.resilientServerIds;

  var stateDelta = this._stateDelta, addWait = 0;
  if (!stateDelta.moveMap)
    stateDelta.moveMap = {};
  if (!stateDelta.serverIdMap)
    stateDelta.serverIdMap = {};
  var perSourceFolder = function perSourceFolder(ignoredConn, targetStorage) {
    this._partitionAndAccessFoldersSequentially(
      op.messages, false,
      function perFolder(ignoredConn, sourceStorage, headers, namers,
                         perFolderDone) {
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

          // We need an entry in the server id map if we are moving it.
          if (header.srvid)
            stateDelta.serverIdMap[sourceSuid] = header.srvid;

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
        var iNextHeader = 0, header = null, body = null, addWait = 0;
        processNext();
      },
      function() {
        doneCallback(null, null, true);
      },
      null,
      false,
      'local move source');
  }.bind(this);
  this._accessFolderForMutation(
    targetFolderId || op.targetFolder, false,
    perSourceFolder, null, 'local move target');
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
        var newSuid = deltaMap[suid];
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
 *   @param[callWhenDone Function]
 *   @param[callOnConnLoss Function]
 *   @param[reverse #:optional Boolean]{
 *     Should we walk the partitions in reverse order?
 *   }
 *   @param[label String]{
 *     The label to use to name the usage of the folder connection.
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
    label) {
  var partitions = $util.partitionMessagesByFolderId(allMessageNamers);
  var folderConn, storage, self = this,
      folderId = null, folderMessageNamers = null, serverIds = null,
      iNextPartition = 0, curPartition = null, modsToGo = 0;

  if (reverse)
    partitions.reverse();

  var openNextFolder = function openNextFolder() {
    if (iNextPartition >= partitions.length) {
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
                                    callOnConnLoss, label);
    }
  };
  var gotFolderConn = function gotFolderConn(_folderConn, _storage) {
    folderConn = _folderConn;
    storage = _storage;
    // - Get headers or resolve current server id from name map
    if (needConn) {
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
    var iNextServerId = serverIds.indexOf(null);
    for (var i = 0; i < headers.length; i++) {
      var header = headers[i];
      if (!header)
        console.warn('missing header!',
                     JSON.stringify(folderMessageNamers[iNextServerId]));
      var srvid = header.srvid;
      serverIds[iNextServerId] = srvid;
      iNextServerId = serverIds.indexOf(null, iNextServerId + 1);
      if (!srvid)
        console.warn('Header', headers[i].suid, 'missing server id in job!');
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
