/**
 *
 **/

define(
  [
    'imap',
    'rdcommon/log',
    './a64',
    './imapdb',
    './imapslice',
    './imapprobe',
    'module',
    'exports'
  ],
  function(
    $imap,
    $log,
    $a64,
    $imapdb,
    $imapslice,
    $imapprobe,
    $module,
    exports
  ) {

function MailUniverse(testingModeLogData, callAfterBigBang) {
  this.accounts = [];
  this._accountsById = {};

  this.config = null;

  if (testingModeLogData) {
    console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.log("! DEVELOPMENT MODE ACTIVE!                !");
    console.log("! LOGGING SUBSYSTEM ENTRAINING USER DATA! !");
    console.log("! (the data does not leave the browser.)  !");
    console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    $log.DEBUG_markAllFabsUnderTest();
  }

  this._LOG = LOGFAB.MailUniverse(this, null, null);
  this._db = new $imapdb.ImapDB();
  var self = this;
  this._db.getConfig(function(configObj, accountInfos) {
    self._LOG.configLoaded(configObj);
    if (configObj) {
      self.config = configObj;
    }
    else {
      self.config = {
        nextAccountNum: 0,
      };
    }
    callAfterBigBang();
  });
}
exports.MailUniverse = MailUniverse;
MailUniverse.prototype = {
  tryToCreateAccount: function(connInfo, callback) {
    var prober = new $imapprobe.ImapProber(connInfo), self = this;
    prober.onresult = function(accountGood, imapProtoConn) {
      if (!accountGood) {
        callback(accountGood, null);
        return;
      }

      // The account is good, but it'll be boring without a list of folders.
      var account = self._actuallyCreateAccount(connInfo, imapProtoConn);
      account.syncFolderList(function() {
        callback(accountGood, account);
      });
    };
  },

  /**
   * Create an account now that we have verified the credentials are good and
   * the server meets our minimal functionality standards.  We are also
   * provided with the protocol connection that was used to perform the check
   * so we can immediately put it to work.
   */
  _actuallyCreateAccount: function(connInfo, imapProtoConn) {
    var accountDef = {
      id: $a64.encodeInt(this.config.nextAccountNum++),
      name: connInfo.username,
      connInfo: connInfo,
    };
    var folderInfo = {
      $meta: {
        nextFolderNum: 0,
      },
    };
    this._db.saveAccountDef(accountDef, folderInfo);

    this._LOG.createAccount(accountDef.id, accountDef.name);
    var account = new ImapAccount(accountDef, folderInfo, this._LOG,
                                  imapProtoConn);
    this.accounts.push(account);
    this._accountsById[account.id] = account;
    return account;
  },

  /**
   * Given a folder-id, get the owning account.
   */
  getAccountForFolderId: function(folderId) {
    var accountId = folderId.substring(0, folderId.indexOf('-')),
        account = this._accountsById[accountId];
    return account;
  },
};

/**
 * Account object, root of all interaction with servers.
 *
 * Passwords are currently held in cleartext with the rest of the data.  Ideally
 * we would like them to be stored in some type of keyring coupled to the TCP
 * API in such a way that we never know the API.  Se a vida e.
 *
 * @typedef[AccountDef @dict[
 *   @key[id AccountId]
 *   @key[name String]{
 *     The display name for the account.
 *   }
 *   @key[connInfo @dict[
 *     @key[host]
 *     @key[port]
 *     @key[crypto]
 *     @key[username]
 *     @key[password]
 *   ]]
 * ]]
 */
function ImapAccount(accountDef, folderInfos, _parentLog, existingProtoConn) {
  this.id = accountDef.id;
  this.accountDef = accountDef;

  this._ownedConns = [];
  if (existingProtoConn)
    this._ownedConns.push({
        conn: existingProtoConn,
        inUse: false,
        folderId: null,
      });

  this._LOG = LOGFAB.ImapAccount(this, _parentLog, this.accountDef.id);

  // Yes, the pluralization is suspect, but unambiguous.
  /** @dictof[@key[FolderId] @value[ImapFolderStorage] */
  var folderStorages = this._folderStorages = {};
  /** @dictof[@key[FolderId] @value[ImapFolderMeta] */
  var folderPubs = this.folders = [];

  /**
   * The list of dead folder id's that we need to nuke the storage for when
   * we next save our account status to the database.
   */
  this._deadFolderIds = null;

  /**
   * The canonical folderInfo object we persist to the database.
   */
  this._folderInfos = folderInfos;
  /**
   * @dict[
   *   @param[nextFolderNum Number]{
   *     The next numeric folder number to be allocated.
   *   }
   *   @param[lastFullFolderProbeAt DateMS]{
   *     When was the last time we went through our list of folders and got the
   *     unread count in each folder.
   *   }
   *   @param[capability String]{
   *     The post-login capability string from the server.
   *   }
   * ]{
   *   Meta-information about the account derived from probing the account.
   *   This information gets flushed on database upgrades.
   * }
   */
  this._meta = this._folderInfos.$meta;
  for (var folderId in folderInfos) {
    if (folderId === "$meta")
      continue;
    var folderInfo = folderInfos[folderId];

    this._LOG.persistedFolder(folderId, folderInfo);
    folderStorages[folderId] =
      new $imapslice.ImapFolderStorage(this, folderId, folderInfo);
    folderPubs.push(folderInfo.$meta);
  }

  if (!folderStorages.hasOwnProperty("INBOX"))
    this._learnAboutFolder("INBOX", "INBOX", 'inbox');
}
ImapAccount.prototype = {
  type: 'imap',
  toString: function() {
    return '[ImapAccount: ' + this.accountDef.id + ']';
  },
  toBridgeWire: function() {
    return {
      id: this.accountDef.id,
      name: this.accountDef.name,
      type: this.type,
      host: this.accountDef.connInfo.host,
      port: this.accountDef.connInfo.port,
      crypto: this.accountDef.connInfo.crypto,
      username: this.accountDef.connInfo.username,
    };
  },

  /**
   * Make a given folder known to us, creating state tracking instances, etc.
   */
  _learnAboutFolder: function(name, path, type) {
    var folderId = this.accountDef.id + '-' +
                     $a64.encodeInt(this._meta.nextFolderNum++);
    this._LOG.learnAboutFolder(folderId, name, path, type);
    var folderInfo = this._folderInfos[folderId] = {
      $meta: {
        id: folderId,
        name: name,
        path: path,
        type: type,
      },
      $impl: {
        nextHeaderBlock: 0,
        nextBodyBlock: 0,
      },
      accuracy: [],
      headerBlocks: [],
      bodyBlocks: [],
    };
    this._folderStorages[folderId] =
      new $imapslice.ImapFolderStorage(this, folderId, folderInfo, this._LOG);
    this.folders.push(folderInfo.$meta);
  },

  /**
   * Create a view slice on the messages in a folder, starting from the most
   * recent messages and synchronizing further as needed.
   */
  sliceFolderMessages: function(folderId, bridgeHandle) {
    var storage = this._folderStorages[folderId],
        slice = new $imapslice.ImapSlice(bridgeHandle, storage, this._LOG);

    storage.sliceOpenFromNow(slice);
  },

  /**
   * Mechanism for an `ImapFolderConn` to request an IMAP protocol connection.
   * This is to potentially support some type of (bounded) connection pooling
   * like Thunderbird uses.  The rationale is that many servers cap the number
   * of connections we are allowed to maintain, plus it's hard to justify
   * locally tying up those resources.  (Thunderbird has more need of watching
   * multiple folders than ourselves, bu we may still want to synchronize a
   * bunch of folders in parallel for latency reasons.)
   *
   * The provided connection will *not* be in the requested folder; it's up to
   * the folder connection to enter the folder.
   */
  __folderDemandsConnection: function(folderId, callback) {
    var reusableConnInfo = null;
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      if (!connInfo.inUse)
        reusableConnInfo = connInfo;
      // It's concerning if the folder already has a connection...
      if (folderId && connInfo.folderId === folderId) {
        this._LOG.folderAlreadyHasConn(folderId);
      }
    }

    if (reusableConnInfo) {
      reusableConnInfo.inUse = true;
      reusableConnInfo.folderId = folderId;
      callback(reusableConnInfo.conn);
      return;
    }

    this._makeConnection(folderId, callback);
  },

  _makeConnection: function(folderId, callback) {
    var opts = {};
    for (var key in this.accountDef.connInfo) {
      opts[key] = this.accountDef.connInfo[key];
    }
    if (this._LOG) opts._logParent = this._LOG;
    var conn = new $imap.ImapConnection(opts);
    this._ownedConns.push({
        conn: conn,
        inUse: true,
        folderId: folderId,
      });
    conn.on('close', function() {
      });
    conn.on('error', function(err) {
        // this hears about connection errors too
        console.warn('Connection error:', err);
      });
    conn.connect(function(err) {
      if (!err) {
        callback(conn);
      }
    });
  },

  __folderDoneWithConnection: function(folderId, conn) {
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      if (connInfo.conn === conn) {
        connInfo.inUse = false;
        connInfo.folderId = null;
        // XXX this will trigger an expunge if not read-only...
        if (folderId)
          conn.closeBox(function() {});
        return;
      }
    }
  },

  syncFolderList: function(callback) {
    var self = this;
    this.__folderDemandsConnection(null, function(conn) {
      conn.getBoxes(self._syncFolderComputeDeltas.bind(self, conn, callback));
    });
  },
  _syncFolderComputeDeltas: function(conn, callback, err, boxesRoot) {
    var self = this;
    if (err) {
      // XXX need to deal with transient failure states
      callback();
      return;
    }

    // - build a map of known existing folders
    var folderPubsByPath = {}, folderPub;
    for (var iFolder = 0; iFolder < this.folders.length; iFolder++) {
      folderPub = this.folders[iFolder];
      folderPubsByPath[folderPub.path] = folderPub;
    }

    // - walk the boxes
    function walkBoxes(boxLevel, pathSoFar) {
      for (var boxName in boxLevel) {
        var box = boxLevel[boxName],
            path = pathSoFar ? (pathSoFar + boxName) : boxName;


        // - already known folder
        if (folderPubsByPath.hasOwnProperty(path)) {
          // mark it with true to show that we've seen it.
          folderPubsByPath = true;
        }
        // - new to us!
        else {
          var type = null;
          // NoSelect trumps everything.
          if (box.attribs.indexOf('NOSELECT') !== -1) {
            type = 'nomail';
          }
          else {
            // Standards-ish:
            // - special-use: http://tools.ietf.org/html/rfc6154
            //   IANA registrations:
            //   http://www.iana.org/assignments/imap4-list-extended
            // - xlist:
            //   https://developers.google.com/google-apps/gmail/imap_extensions

            // Process the attribs for goodness.
            for (var i = 0; i < box.attribs.length; i++) {
              switch (box.attribs[i]) {
                case 'ALL': // special-use
                case 'ALLMAIL': // xlist
                case 'ARCHIVE': // special-use
                  type = 'archive';
                  break;
                case 'DRAFTS': // special-use xlist
                  type = 'drafts';
                  break;
                case 'FLAGGED': // special-use
                  type = 'starred';
                  break;
                case 'INBOX': // xlist
                  type = 'inbox';
                  break;
                case 'JUNK': // special-use
                  type = 'junk';
                  break;
                case 'SENT': // special-use xlist
                  type = 'sent';
                  break;
                case 'SPAM': // xlist
                  type = 'junk';
                  break;
                case 'STARRED': // xlist
                  type = 'starred';
                  break;

                case 'TRASH': // special-use xlist
                  type = 'trash';
                  break;

                case 'HASCHILDREN': // 3348
                case 'HASNOCHILDREN': // 3348

                // - standard bits we don't care about
                case 'MARKED': // 3501
                case 'UNMARKED': // 3501
                case 'NOINFERIORS': // 3501
                  // XXX use noinferiors to prohibit folder creation under it.
                // NOSELECT

                default:
              }
            }

            // heuristic based type assignment based on the name
            if (!type) {
              switch (path.toUpperCase()) {
                case 'DRAFT':
                case 'DRAFTS':
                  type = 'drafts';
                  break;
                case 'INBOX':
                  type = 'inbox';
                  break;
                case 'JUNK':
                case 'SPAM':
                  type = 'junk';
                  break;
                case 'SENT':
                  type = 'sent';
                  break;
                case 'TRASH':
                  type = 'trash';
                  break;
              }
            }

            if (!type)
              type = 'normal';
          }

          self._learnAboutFolder(boxName, path, type);
        }

        if (box.children)
          walkBoxes(box.children, pathSoFar + box.delim);
      }
    }
    walkBoxes(boxesRoot, '');

    // - detect deleted folders
    // track dead folder id's so we can issue a
    var deadFolderIds = [];
    for (var folderPath in folderPubsByPath) {
      folderPub = folderPubsByPath[folderPath];
      // (skip those we found above)
      if (folderPub === true)
        continue;
      // It must have gotten deleted!
      delete this._folderInfos[folderPub.id];
      var folderStorage = this._folderStorages[folderPub.id];
      delete this._folderStorages[folderPub.id];
      if (this._deadFolderIds === null)
        this._deadFolderIds = [];
      this._deadFolderIds.push(folderPub.id);
      folderStorage.youAreDeadCleanupAfterYourself();
    }

    callback();
  },
};

/**
 * While gmail deserves major props for providing any IMAP interface, everyone
 * is much better off if we treat it specially.
 */
function GmailAccount() {
}
GmailAccount.prototype = {
  type: 'gmail-imap',

};

const ACCOUNT_TYPE_TO_CLASS = {
  'imap': ImapAccount,
  //'gmail-imap': GmailAccount,
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  MailUniverse: {
    type: $log.ACCOUNT,
    events: {
      configLoaded: {},
      createAccount: { id: false },
    },
    TEST_ONLY_events: {
      configLoaded: { config: false },
      createAccount: { name: false },
    },
  },

  ImapAccount: {
    type: $log.ACCOUNT,
    events: {
      persistedFolder: { folderId: false },
      learnAboutFolder: { folderId: false },
    },
    TEST_ONLY_events: {
      persistedFolder: { folderInfo: false },
      learnAboutFolder: { name: false, path: false, type: false },
    },
    errors: {
      folderAlreadyHasConn: { folderId: false },
    },
  },
});

}); // end define
