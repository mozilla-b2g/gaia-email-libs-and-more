define(
  [
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    './util',
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
  local_do_modtags: function(op, callback) {
    for (let [,message] in Iterator(op.messages)) {
      let folderId = message.suid.substring(0, message.suid.lastIndexOf('/'));
      let folderStorage = this.account.getFolderStorageForFolderId(folderId);

      for (let [i, header] in Iterator(folderStorage._headers)) {
        if (header.suid === message.suid) {
          for (let [,add] in Iterator(op.addTags || []))
            header.flags.push(add);
          for (let [,remove] in Iterator(op.removeTags || [])) {
            let index = header.flags.indexOf(remove);
            if (index !== -1)
              header.flags.splice(index, 1);
          }
          folderStorage._bridgeHandle.sendUpdate([i, header]);
          break;
        }
      }
    }

    this.account.saveAccountState();
    if (callback)
      setZeroTimeout(callback);
  },

  do_modtags: function(op, callback) {
    let jobDriver = this;

    if (!this.account.conn.connected) {
      let self = this;
      this.account.conn.autodiscover(function(config) {
        // TODO: handle errors
        jobDriver.do_modtags(op, callback);
      });
      return;
    }

    // XXX: we really only want the message ID, but this method tries to parse
    // it as an int (it's a GUID).
    let partitions = $util.partitionMessagesByFolderId(op.messages, false);

    let markRead = op.addTags && op.addTags.indexOf('\\Seen') !== -1;
    let markStar = op.addTags && op.addTags.indexOf('\\Flagged') !== -1;
    let markUnread = op.removeTags && op.removeTags.indexOf('\\Seen') !== -1;
    let markUnstar = op.removeTags && op.removeTags.indexOf('\\Flagged') !== -1;

    const as = $ascp.AirSync.Tags;
    const em = $ascp.Email.Tags;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(as.Sync)
       .stag(as.Collections);

    for (let [,part] in Iterator(partitions)) {
      let folderStorage = this.account.getFolderStorageForFolderId(
        part.folderId);

      w.stag(as.Collection);

      if (this.account.conn.currentVersionInt < $activesync.VersionInt('12.1'))
        w.tag(as.Class, 'Email');

        w.tag(as.SyncKey, folderStorage.folderMeta.syncKey)
           .tag(as.CollectionId, folderStorage.serverId)
           .stag(as.Commands);

      for (let [,message] in Iterator(part.messages)) {
        let slash = message.lastIndexOf('/');
        let guid = message.substring(slash+1);

        w.stag(as.Change)
           .tag(as.ServerId, guid)
           .stag(as.ApplicationData);

        if (markRead)
          w.tag(em.Read, '1');
        if (markUnread)
          w.tag(em.Read, '0');

        // XXX: add flagging/unflagging

          w.etag()
         .etag();
      }

        w.etag()
       .etag();
    }

      w.etag()
     .etag();

    this.account.conn.doCommand(w, function(aError, aResponse) {
      if (aError)
        return;

      let e = new $wbxml.EventParser();

      let status;
      e.addEventListener([as.Sync, as.Collections, as.Collection, as.Status],
                         function(node) {
        status = node.children[0].textContent;
      });

      e.run(aResponse);

      if (status === '1') { // Success
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
