/**
 *
 **/

define(
  [
    './worker-router',
    'exports'
  ],
  function(
    $router,
    exports
  ) {
'use strict';

var uid = 0;
var callbacks = {};
function sendMessage(cmd, args, callback) {
  if (callback) {
    callbacks[uid] = callback;
  }

  if (!Array.isArray(args)) {
    args = args ? [args] : [];
  }

  self.postMessage({ uid: uid++, type: 'maildb', cmd: cmd, args: args });
}

function receiveMessage(evt) {
  var data = evt.data;
  dump("MailDB: receiveMessage " + data.cmd + "\n");

  var callback = callbacks[data.uid];
  if (!callback)
    return;
  delete callbacks[data.uid];
  dump("MailDB: receiveMessage fire callback\n");
  callback.apply(callback, data.args);
}

function MailDB(testOptions) {
  this._callbacksQueue = [];
  function processQueue() {
    this._ready = true;

    this._callbacksQueue.forEach(function executeCallback(cb) {
      cb();
    });
    this._callbacksQueue = null;
  }

  sendMessage('open', testOptions, processQueue.bind(this));
}
exports.MailDB = MailDB;
MailDB.prototype = {
  close: function() {
    sendMessage('close');
  },

  getConfig: function(callback, trans) {
    // XXX vn Does trans deserve any purpose?
    if (!this._ready) {
      this._callbacksQueue.push(this.getConfig.bind(this, callback));
       return;
     }

    sendMessage('getConfig', null, callback);
  },

  saveConfig: function(config) {
    sendMessage('saveConfig', config);
  },

  saveAccountDef: function(config, accountDef, folderInfo) {
    sendMessage('saveAccountDef', [ config, accountDef, folderInfo ]);
  },

  loadHeaderBlock: function(folderId, blockId, callback) {
    sendMessage('loadHeaderBlock', [ folderId, blockId], callback);
  },

  loadBodyBlock: function(folderId, blockId, callback) {
    sendMessage('loadBodyBlock', [ folderId, blockId], callback);
  },

  saveAccountFolderStates: function(accountId, folderInfo, perFolderStuff,
                                    deletedFolderIds, callback, reuseTrans) {
    var args = [ accountId, folderInfo, perFolderStuff, deletedFolderIds ];
    sendMessage('saveAccountFolderStates', args, callback);
    // XXX vn Does this deserve any purpose?
    return null;
  },

  deleteAccount: function(accountId) {
    sendMessage('deleteAccount', accountId);
  },
};

$router.register('maildb', receiveMessage);

}); // end define
