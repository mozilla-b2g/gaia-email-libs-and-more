/**
 *
 **/

define(
  [
    'rdcommon/log',
    'mailcomposer',
    './util',
    'module',
    'exports'
  ],
  function(
    $log,
    $mailcomposer,
    $imaputil,
    $module,
    exports
  ) {
const bsearchForInsert = $imaputil.bsearchForInsert,
      bsearchMaybeExists = $imaputil.bsearchMaybeExists;

function toBridgeWireOn(x) {
  return x.toBridgeWire();
}

function cmpFolderMarkers(a, b) {
  var d = a[0].localeCompare(b[0]);
  if (d)
    return d;
  return a[1].localeCompare(b[1]);
}

/**
 * There is exactly one `MailBridge` instance for each `MailAPI` instance.
 * `same-frame-setup.js` is the only place that hooks them up together right
 * now.
 */
function MailBridge(universe) {
  this.universe = universe;

  this._LOG = LOGFAB.MailBridge(this, universe._LOG, null);
  /** @dictof[@key[handle] @value[BridgedViewSlice]]{ live slices } */
  this._slices = {};
  /** @dictof[@key[namespace] @value[@listof[BridgedViewSlice]]] */
  this._slicesByType = {
    accounts: [],
    identities: [],
    folders: [],
    headers: [],
  };
  // outstanding persistent objects that aren't slices. covers: composition
  this._pendingRequests = {};
  //
  this._lastUndoableOpPair = null;
}
exports.MailBridge = MailBridge;
MailBridge.prototype = {
  __sendMessage: function(msg) {
    throw new Error('This is supposed to get hidden by an instance var.');
  },

  __receiveMessage: function mb___receiveMessage(msg) {
    var implCmdName = '_cmd_' + msg.type;
    if (!(implCmdName in this)) {
      this._LOG.badMessageType(msg.type);
      return;
    }
    var rval = this._LOG.cmd(msg.type, this, this[implCmdName], msg);
  },

  _cmd_ping: function mb__cmd_ping(msg) {
    this.__sendMessage({
      type: 'pong',
      handle: msg.handle,
    });
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
          new SliceBridgeProxy(this, 'accounts', msg.handle);
    this._slicesByType['accounts'].push(proxy);
    var wireReps = this.universe.accounts.map(toBridgeWireOn);
    // send all the accounts in one go.
    proxy.sendSplice(0, 0, wireReps, true, false);
  },

  _cmd_viewSenderIdentities: function mb__cmd_viewSenderIdentities(msg) {
    var proxy = this._slices[msg.handle] =
          new SliceBridgeProxy(this, identities, msg.handle);
    this._slicesByType['identities'].push(proxy);
    var wireReps = this.universe.identities;
    // send all the identities in one go.
    proxy.sendSplice(0, 0, wireReps, true, false);
  },

  notifyFolderAdded: function(accountId, folderMeta) {
    var newMarker = [accountId, folderMeta.path];

    var slices = this._slicesByType['folders'];
    for (var i = 0; i < slices.length; i++) {
      var proxy = slices[i];
      var idx = bsearchForInsert(proxy.markers, newMarker, cmpFolderMarkers);
      proxy.sendSplice(idx, 0, [folderMeta], false, false);
      proxy.markers.splice(idx, 0, newMarker);
    }
  },

  notifyFolderRemoved: function(accountId, folderMeta) {
    var marker = [accountId, folderMeta.path];

    var slices = this._slicesByType['folders'];
    for (var i = 0; i < slices.length; i++) {
      var proxy = slices[i];

      var idx = bsearchMaybeExists(proxy.markers, marker, cmpFolderMarkers);
      if (idx === null)
        continue;
      proxy.sendSplice(idx, 1, [], false, false);
      proxy.markers.splice(idx, 1);
    }
  },

  _cmd_viewFolders: function mb__cmd_viewFolders(msg) {
    var proxy = this._slices[msg.handle] =
          new SliceBridgeProxy(this, 'folders', msg.handle);
    this._slicesByType['folders'].push(proxy);
    proxy.mode = msg.mode;
    proxy.argument = msg.argument;
    var markers = proxy.markers = [];

    var wireReps = [];

    function pushAccountFolders(acct) {
      for (var iFolder = 0; iFolder < acct.folders.length; iFolder++) {
        var folder = acct.folders[iFolder];
        wireReps.push(folder);
        markers.push([acct.id, folder.path]);
      }
    }

    if (msg.mode === 'account') {
      pushAccountFolders(
        this.universe.getAccountForAccountId(msg.argument));
    }
    else {
      var accounts = this.universe.accounts;

      for (var iAcct = 0; iAcct < accounts.length; iAcct++) {
        var acct = accounts[iAcct];
        wireReps.push(acct.toBridgeWire());
        markers.push([acct.id, '']);
        pushAccountFolders(acct);
      }
    }
    proxy.sendSplice(0, 0, wireReps, true, false);
  },

  _cmd_viewFolderMessages: function mb__cmd_viewFolderMessages(msg) {
    var proxy = this._slices[msg.handle] =
          new SliceBridgeProxy(this, 'headers', msg.handle);
    this._slicesByType['headers'].push(proxy);

    var account = this.universe.getAccountForFolderId(msg.folderId);
    account.sliceFolderMessages(msg.folderId, proxy);
  },

  _cmd_refreshHeaders: function mb__cmd_refreshHeaders(msg) {
    var proxy = this._slices[msg.handle];
    if (!proxy) {
      this._LOG.badSliceHandle(msg.handle);
      return;
    }
    proxy.__listener.refresh();
  },

  _cmd_killSlice: function mb__cmd_killSlice(msg) {
    var proxy = this._slices[msg.handle];
    if (!proxy) {
      this._LOG.badSliceHandle(msg.handle);
      return;
    }

    delete this._slices[msg.handle];
    var proxies = this._slicesByType[proxy._ns],
        idx = proxies.indexOf(proxy);
    proxies.splice(idx, 1);
    proxy.die();

    this.__sendMessage({
      type: 'sliceDead',
      handle: msg.handle,
    });
  },

  _cmd_getBody: function mb__cmd_getBody(msg) {
    var self = this;
    // map the message id to the folder storage
    var folderId = msg.suid.substring(0, msg.suid.lastIndexOf('/'));
    var folderStorage = this.universe.getFolderStorageForFolderId(folderId);
    folderStorage.getMessageBody(msg.suid, msg.date, function(bodyInfo) {
      self.__sendMessage({
        type: 'gotBody',
        handle: msg.handle,
        bodyInfo: bodyInfo,
      });
    });
  },

  //////////////////////////////////////////////////////////////////////////////
  // Message Mutation
  //
  // All mutations are told to the universe which breaks the modifications up on
  // a per-account basis.

  _cmd_modifyMessageTags: function mb__cmd_modifyMessageTags(msg) {
    // XXXYYY

    // - The mutations are written to the database for persistence (in case
    //   we fail to make the change in a timely fashion) and so that we can
    //   know enough to reverse the operation.
    // - Speculative changes are made to the headers in the database locally.

    this.universe.modifyMessageTags(
      msg.opcode, msg.messages, msg.addTags, msg.removeTags);
  },

  //////////////////////////////////////////////////////////////////////////////
  // Composition

  _cmd_beginCompose: function mb__cmd_beginCompose(msg) {
    var req = this._pendingRequests[msg.handle] = {
      type: 'compose',
      // XXX draft persistence/saving to-do/etc.
      persistedFolder: null,
      persistedUID: null,
    };

    // - figure out the identity to use
    var account, identity;
    if (msg.mode === 'new' && msg.submode === 'folder')
      account = this.universe.getAccountForFolderId(msg.reference);
    else
      account = this.universe.getAccountForMessageSuid(msg.reference);

    identity = account.identities[0];

    this.__sendMessage({
      type: 'composeBegun',
      handle: msg.handle,
      identity: identity,
      subject: '',
      body: '',
      to: [],
      cc: [],
      bcc: [],
    });
  },

  /**
   * mailcomposer wants from/to/cc/bcc delivered basically like it will show
   * up in the e-mail, except it is fine with unicode.  So we convert our
   * (possibly) structured representation into a flattened representation.
   *
   * (mailcomposer will handle punycode and mime-word encoding as needed.)
   */
  _formatAddresses: function(nameAddrPairs) {
    var addrstrings = [];
    for (var i = 0; i < nameAddrPairs.length; i++) {
      var pair = nameAddrPairs[i];
      // support lazy people providing only an e-mail... or very careful
      // people who are sure they formatted things correctly.
      if (typeof(pair) === 'string') {
        addrstrings.push(pair);
      }
      else {
        addrstrings.push(
          '"' + pair.name.replace(/["']/g, '') + '" <' +
            pair.address + '>');
      }
    }

    return addrstrings.join(', ');
  },

  _cmd_doneCompose: function mb__cmd_doneCompose(msg) {
    if (msg.command === 'delete') {
      // XXX if we have persistedFolder/persistedUID, enqueue a delete of that
      // message and try and execute it.
      return;
    }

    var composer = new $mailcomposer.MailComposer(),
        wireRep = msg.state;
    var identity = this.universe.getIdentityForSenderIdentityId(
                     wireRep.senderId),
        account = this.universe.getAccountForSenderIdentityId(
                    wireRep.senderId);

    var body = wireRep.body;
    if (identity.signature) {
      if (body[body.length - 1] !== '\n')
        body += '\n';
      body += '-- \n' + identity.signature;
    }

    var messageOpts = {
      from: this._formatAddresses([identity]),
      subject: wireRep.subject,
      body: body
    };
    if (identity.replyTo)
      messageOpts.replyTo = identity.replyTo;
    if (wireRep.to && wireRep.to.length)
      messageOpts.to = this._formatAddresses(wireRep.to);
    if (wireRep.cc && wireRep.cc.length)
      messageOpts.cc = this._formatAddresses(wireRep.cc);
    if (wireRep.bcc && wireRep.bcc.length)
      messageOpts.bcc = this._formatAddresses(wireRep.bcc);
    composer.setMessageOption(messageOpts);

    if (wireRep.customHeaders) {
      for (var iHead = 0; iHead < wireRep.customHeaders.length; iHead += 2){
        composer.addHeader(wireRep.customHeaders[iHead],
                           wireRep.customHeaders[iHead+1]);
      }
    }
    composer.addHeader('User-Agent', 'Mozilla Gaia Email Client 0.1alpha');
    composer.addHeader('Date', new Date().toUTCString());
    // we're copying nodemailer here; we might want to include some more...
    var messageId =
      '<' + Date.now() + Math.random().toString(16).substr(1) + '@mozgaia>';

    composer.addHeader('Message-Id', messageId);

    if (msg.command === 'send') {
      var self = this;
      account.sendMessage(composer, function(err, badAddresses) {
        self.__sendMessage({
          type: 'sent',
          handle: msg.handle,
          err: err,
          badAddresses: badAddresses,
          messageId: messageId,
        });
      });
    }
    else { // (msg.command === draft)
      // XXX save drafts!
    }
  },

  //////////////////////////////////////////////////////////////////////////////
};

function SliceBridgeProxy(bridge, ns, handle) {
  this._bridge = bridge;
  this._ns = ns;
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

  sendUpdate: function sbp_sendUpdate(indexUpdatesRun) {
    this._bridge.__sendMessage({
      type: 'sliceUpdate',
      handle: this._handle,
      updates: indexUpdatesRun,
    });
  },

  sendStatus: function sbp_sendStatus(status, flushSplice) {
    if (flushSplice) {
      this.sendSplice(0, 0, [], true, false);
    }
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
      badMessageType: { type: true },
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
