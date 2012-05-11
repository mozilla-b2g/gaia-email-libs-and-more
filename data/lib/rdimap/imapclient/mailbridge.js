/**
 *
 **/

define(
  [
    'rdcommon/log',
    './imapacct',
    'module',
    'exports'
  ],
  function(
    $log,
    $imapacct,
    $module,
    exports
  ) {

function toBridgeWireOn(x) {
  return x.toBridgeWire();
}

/**
 * There is exactly one `MailBridge` instance for each `MailAPI` instance.
 * `same-frame-setup.js` is the only place that hooks them up together right
 * now.
 */
function MailBridge(universe) {
  this.universe = universe;

  this._LOG = LOGFAB.MailBridge(this, universe._LOG, null);
  this._slices = {};
}
exports.MailBridge = MailBridge;
MailBridge.prototype = {
  __sendMessage: function(msg) {
    throw new Error('This is supposed to get hidden by an instance var.');
  },

  __receiveMessage: function mb___receiveMessage(msg) {
    var implCmdName = '_cmd_' + msg.type;
    if (!(implCmdName in this)) {
      console.warn('Bad message type:', msg.type);
      return;
    }
    this._LOG.cmd(msg.type, this, this[implCmdName], msg);
  },

  _cmd_tryToCreateAccount: function mb__cmd_tryToCreateAccount(msg) {
    var self = this;
    this.universe.tryToCreateAccount(msg.details, function(good, account) {
        self.__sendMessage({
            type: 'tryToCreateAccountResults',
            handle: msg.handle,
            error: good ? null : 'generic-badness',
          });
      });
  },

  _cmd_viewAccounts: function mb__cmd_viewAccounts(msg) {
    var proxy = this._slices[msg.handle] =
          new SliceBridgeProxy(this, msg.handle);
    var wireReps = this.universe.accounts.map(toBridgeWireOn);
    // send all the accounts in one go.
    proxy.sendSplice(0, 0, wireReps, true, false);
  },

  _cmd_viewFolders: function mb__cmd_viewFolders(msg) {
    var proxy = this._slices[msg.handle] =
          new SliceBridgeProxy(this, msg.handle),
        accounts = this.universe.accounts;
    var wireReps = [];
    // Tell the other side about all the accounts/folders all at once.  There
    // is no benefit to only telling it about a subset.  However, we may derive
    // a benefit from knowing the approximate visual range in terms of asking
    // folders about their unread counts.
    for (var iAcct = 0; iAcct < accounts.length; iAcct++) {
      var acct = accounts[iAcct];
      wireReps.push(acct.toBridgeWire());
      for (var iFolder = 0; iFolder < acct.folders.length; iFolder++) {
        var folder = acct.folders[iFolder];
        wireReps.push(folder);
      }
    }
    proxy.sendSplice(0, 0, wireReps, true, false);
  },

  _cmd_viewFolderMessages: function mb__cmd_viewFolderMessages(msg) {
    var proxy = this._slices[msg.handle] =
          new SliceBridgeProxy(this, msg.handle);

    var account = this.universe.getAccountForFolderId(msg.folderId);
    account.sliceFolderMessages(msg.folderId, proxy);
  },

  _cmd_killSlice: function mb__cmd_killSlice(msg) {
    var proxy = this._slices[msg.handle];
    if (!proxy) {
      this._LOG.badSliceHandle(msg.handle);
      return;
    }

    delete this._slices[msg.handle];
    proxy.die();
  },

  _cmd_getBody: function mb__cmd_getBody(msg) {
    var self = this;
    // map the message id to the folder storage
    var folderId = msg.suid.substring(0, msg.suid.lastIndexOf('-'));
    var folderStorage = this.universe.getFolderStorageForFolderId(folderId);
    folderStorage.getMessageBody(msg.suid, msg.date, function(bodyInfo) {
      self.__sendMessage({
        type: 'gotBody',
        handle: msg.handle,
        bodyInfo: bodyInfo,
      });
    });
  },
};

function SliceBridgeProxy(bridge, handle) {
  this._bridge = bridge;
  this._handle = handle;
  this.__listener = null;
}
SliceBridgeProxy.prototype = {
  sendSplice: function sbp_sendSplice(index, howMany, addItems, requested,
                                      moreExpected) {
    this._bridge.__sendMessage({
      type: 'sliceSplice',
      handle: this._handle,
      index: index,
      howMany: howMany,
      addItems: addItems,
      requested: requested,
      moreExpected: moreExpected,
    });
  },

  sendUpdate: function sbp_sendUpdate() {
  },

  sendStatus: function sbp_sendStatus() {
  },

  die: function sbp_die() {
    if (this.__listener)
      this.__listener.die();
  },
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  MailBridge: {
    type: $log.DAEMON,
    events: {
    },
    TEST_ONLY_events: {
    },
    errors: {
      badSliceHandle: { handle: true },
    },
    calls: {
      cmd: {command: true},
    },
    TEST_ONLY_calls: {
    },
  },
});

}); // end define
