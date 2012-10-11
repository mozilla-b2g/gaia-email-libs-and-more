define(
  [
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    '../util',
    'exports'
  ],
  function(
    $wbxml,
    $ascp,
    $activesync,
    $util,
    exports
  ) {
'use strict';

function ActiveSyncJobDriver(account) {
  this.account = account;
}
exports.ActiveSyncJobDriver = ActiveSyncJobDriver;
ActiveSyncJobDriver.prototype = {
  postJobCleanup: function() {
  },

  local_do_modtags: function(op, callback) {
    // XXX: we'll probably remove this once deleting stops being a modtag op
    if (op.addTags && op.addTags.indexOf('\\Deleted') !== -1)
      return this.local_do_delete(op, callback);

    for (let [,message] in Iterator(op.messages)) {
      let lslash = message.suid.lastIndexOf('/');
      let folderId = message.suid.substring(0, lslash);
      let messageId = message.suid.substring(lslash + 1);
      let folderStorage = this.account.getFolderStorageForFolderId(folderId);

      folderStorage.updateMessageHeader(message.date, messageId, false,
                                        function(header) {
        let modified = false;

        for (let [,tag] in Iterator(op.addTags || [])) {
          if (header.flags.indexOf(tag) !== -1)
            continue;
          header.flags.push(tag);
          header.flags.sort();
          modified = true;
        }
        for (let [,remove] in Iterator(op.removeTags || [])) {
          let index = header.flags.indexOf(remove);
          if (index === -1)
            continue;
          header.flags.splice(index, 1);
          modified = true;
        }
        return modified;
      });
    }

    this.account.saveAccountState();
    if (callback)
      setZeroTimeout(callback);
  },

  do_modtags: function(op, callback) {
    function getMark(tag) {
      if (op.addTags && op.addTags.indexOf(tag) !== -1)
        return true;
      if (op.removeTags && op.removeTags.indexOf(tag) !== -1)
        return false;
      return undefined;
    }

    // XXX: we'll probably remove this once deleting stops being a modtag op
    if (getMark('\\Deleted'))
      return this.do_delete(op, callback);

    let markRead = getMark('\\Seen');
    let markFlagged = getMark('\\Flagged');

    this._do_crossFolderOp(op, callback, function(w, messageGuid) {
      const as = $ascp.AirSync.Tags;
      const em = $ascp.Email.Tags;

      w.stag(as.Change)
         .tag(as.ServerId, messageGuid)
         .stag(as.ApplicationData);

      if (markRead !== undefined)
        w.tag(em.Read, markRead ? '1' : '0');

      if (markFlagged !== undefined)
        w.stag(em.Flag)
           .tag(em.Status, markFlagged ? '2' : '0')
         .etag();

        w.etag()
       .etag();
    });
  },

  check_modtags: function(op, callback) {
    callback(null, 'idempotent');
  },

  local_do_delete: function(op, callback) {
    for (let [,message] in Iterator(op.messages)) {
      let lslash = message.suid.lastIndexOf('/');
      let folderId = message.suid.substring(0, lslash);
      let messageId = message.suid.substring(lslash + 1);
      let folderStorage = this.account.getFolderStorageForFolderId(folderId);

      folderStorage.deleteMessageByUid(messageId);
    }

    this.account.saveAccountState();
    if (callback)
      setZeroTimeout(callback);
  },

  do_delete: function(op, callback) {
    this._do_crossFolderOp(op, callback, function(w, messageGuid) {
      const as = $ascp.AirSync.Tags;

      w.stag(as.Delete)
         .tag(as.ServerId, messageGuid)
       .etag();
    });
  },

  check_delete: function(op, callback) {
    callback(null, 'idempotent');
  },

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

  _do_crossFolderOp: function(op, callback, command) {
    let jobDriver = this;

    if (!this.account.conn.connected) {
      this.account.conn.connect(function(error, config) {
        if (error)
          console.error(error);
        else
          jobDriver.do_modtags(op, callback);
      });
      return;
    }

    // XXX: we really only want the message ID, but this method tries to parse
    // it as an int (it's a GUID).
    let partitions = $util.partitionMessagesByFolderId(op.messages, false);

    const as = $ascp.AirSync.Tags;
    const em = $ascp.Email.Tags;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(as.Sync)
       .stag(as.Collections);

    for (let [,part] in Iterator(partitions)) {
      let folderStorage = this.account.getFolderStorageForFolderId(
        part.folderId);

      w.stag(as.Collection);

      if (this.account.conn.currentVersion.lt('12.1'))
        w.tag(as.Class, 'Email');

        w.tag(as.SyncKey, folderStorage.folderMeta.syncKey)
         .tag(as.CollectionId, folderStorage.folderMeta.serverId)
         .stag(as.Commands);

      for (let [,message] in Iterator(part.messages)) {
        let slash = message.lastIndexOf('/');
        let messageGuid = message.substring(slash+1);

        command(w, messageGuid);
      }

        w.etag(as.Commands)
       .etag(as.Collection);
    }

      w.etag(as.Collections)
     .etag(as.Sync);

    this.account.conn.postCommand(w, function(aError, aResponse) {
      if (aError)
        return;

      let e = new $wbxml.EventParser();

      let statuses = [];
      let syncKeys = [];
      let collectionIds = [];

      const base = [as.Sync, as.Collections, as.Collection];
      e.addEventListener(base.concat(as.SyncKey), function(node) {
        syncKeys.push(node.children[0].textContent);
      });
      e.addEventListener(base.concat(as.CollectionId), function(node) {
        collectionIds.push(node.children[0].textContent);
      });
      e.addEventListener(base.concat(as.Status), function(node) {
        statuses.push(node.children[0].textContent);
      });

      e.run(aResponse);

      let allGood = statuses.reduce(function(good, status) {
        return good && status === '1';
      }, true);

      if (allGood) {
        for (let i = 0; i < collectionIds.length; i++) {
          let folderStorage = jobDriver.account.getFolderStorageForServerId(
            collectionIds[i]);
          folderStorage.folderMeta.syncKey = syncKeys[i];
        }

        if (callback)
          callback();
        jobDriver.account.saveAccountState();
      }
      else {
        console.error('Something went wrong during ActiveSync syncing and we ' +
                      'got a status of ' + status);
      }
    });
  },
};

}); // end define
