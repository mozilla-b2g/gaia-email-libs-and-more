/**
 *
 **/

define(
  [
    'imap',
    './a64',
    './imapdb',
    './imapslice',
    './imapprobe',
    'exports'
  ],
  function(
    $imap,
    $a64,
    $imapdb,
    $imapslice,
    $imapprobe,
    exports
  ) {

function MailUniverse(callAfterBigBang) {
  this.accounts = [];

  this.config = null;

  this._db = new $imapdb.ImapDB();
  var self = this;
  this._db.getConfig(function(configObj, accountInfos) {
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

    var account = new ImapAccount(accountDef, folderInfo);
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
function ImapAccount(accountDef, folderInfos) {
  this.accountDef = accountDef;

  this._ownedConns = [];

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
    console.log("DEPERSIST folder", folderId, folderInfo);
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
    console.log("LEARN about folder", name, path, type);
    var folderId = this.accountDef.id + '-' +
                     $a64.encodeInt(this._meta.nextFolderNum++);
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
      new $imapslice.ImapFolderStorage(this, folderId, folderInfo);
    this.folders.push(folderInfo.$meta);
  },

  /**
   * Create a view slice on the messages in a folder, starting from the most
   * recent messages and synchronizing further as needed.
   */
  sliceFolderMessages: function(folderPub, bridgeHandle) {
    var storage = this._folderStorages[folderPub.id],
        slice = new $imapslice.ImapSlice(bridgeHandle, storage);

    storage.sliceOpenFromNow(slice, 14);
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
    opts.debug = console.debug.bind(console);

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

}); // end define
