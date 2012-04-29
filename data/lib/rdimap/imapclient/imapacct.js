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

function MailUniverse(callAfterBigBang) {
  this.accounts = [];

  this.config = null;

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
    prober.onresult = function(accountGood) {
      var account = null;
      if (accountGood) {
        account = self._actuallyCreateAccount(connInfo);
      }
      callback(accountGood, account);
    };
  },

  _actuallyCreateAccount: function(connInfo) {
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
    var account = new ImapAccount(accountDef, folderInfo, this._LOG);
    this.accounts.push(account);
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
function ImapAccount(accountDef, folderInfos, _parentLog) {
  this.accountDef = accountDef;

  this._ownedConns = [];
  this._LOG = LOGFAB.ImapAccount(this, _parentLog, this.accountDef.id);

  // Yes, the pluralization is suspect, but unambiguous.
  var folderStorages = this._folderStorages = {};
  var folderPubs = this.folders = [];

  /**
   * The canonical folderInfo object we persist to the database.
   */
  this._folderInfos = folderInfos;
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
  sliceFolderMessages: function(folderPub, bridgeHandle) {
    var storage = this._folderStorages[folderPub.id],
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
    var opts = {};
    for (var key in this.accountDef.connInfo) {
      opts[key] = this.accountDef.connInfo[key];
    }
    if (this._LOG) opts._logParent = this._LOG;

    var conn = new $imap.ImapConnection(opts);
    this._ownedConns.push({
        conn: conn,
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
  },
});

}); // end define
