define(
  [
    './util',
    'exports'
  ],
  function(
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
  },

  do_modtags: function(op, callback) {},
};

}); // end define
