/**
 *
 **/

define(
  [
    'rdcommon/log',
    './a64',
    './allback',
    './imapdb',
    './imapprobe',
    './imapacct',
    './smtpprobe',
    './smtpacct',
    'module',
    'exports'
  ],
  function(
    $log,
    $a64,
    $allback,
    $imapdb,
    $imapprobe,
    $imapacct,
    $smtpprobe,
    $smtpacct,
    $module,
    exports
  ) {
const allbackMaker = $allback.allbackMaker;

const PIECE_ACCOUNT_TYPE_TO_CLASS = {
  'imap': $imapacct.ImapAccount,
  'smtp': $smtpacct.SmtpAccount,
  //'gmail-imap': GmailAccount,
};

/**
 * Composite account type to expose account piece types with individual
 * implementations (ex: imap, smtp) together as a single account.  This is
 * intended to be a very thin layer that shields consuming code from the
 * fact that IMAP and SMTP are not actually bundled tightly together.
 */
function CompositeAccount(accountDef, receivePiece, sendPiece) {
  this.id = accountDef.id;
  this.accountDef = accountDef;

  this._receivePiece = receivePiece;
  this._sendPiece = sendPiece;

  // expose public lists that are always manipulated in place.
  this.folders = this._receivePiece.folders;
}
CompositeAccount.prototype = {
  sliceFolderMessages: function(folderId, bridgeProxy) {
    return this._receivePiece.sliceFolderMessages(folderId, bridgeProxy);
  },

  syncFolderList: function(callback) {
    return this._receivePiece.syncFolderList(callback);
  },
};

const COMPOSITE_ACCOUNT_TYPE_TO_CLASS = {
  'imap+smtp': CompositeAccount,
};


// Simple hard-coded autoconfiguration by domain...
var autoconfigByDomain = {
  'yahoo.com': {
    type: 'imap+smtp',
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    imapCrypto: true,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 465,
    smtpCrypto: true,
    usernameIsFullEmail: true,
  },
  'localhost': {
    type: 'imap+smtp',
    imapHost: 'localhost',
    imapPort: 143,
    imapCrypto: false,
    smtpHost: 'localhost',
    smtpPort: 25,
    smtpCrypto: false,
    usernameIsFullEmail: false,
  },
};



/**
 * The MailUniverse is the keeper of the database, the root logging instance,
 * and the mail accounts.  It loads the accounts from the database on startup
 * asynchronously, so whoever creates it needs to pass a callback for it to
 * invoke on successful startup.
 *
 * Our concept of mail accounts bundles together both retrieval (IMAP,
 * activesync) and sending (SMTP, activesync) since they really aren't
 * separable and in some cases are basically the same (activesync) or coupled
 * (BURL SMTP pulling from IMAP, which we don't currently do but aspire to).
 *
 * @typedef[ConnInfo @dict[
 *   @key[hostname]
 *   @key[port]
 *   @key[crypto @oneof[
 *     @case[false]{
 *       No encryption; plaintext.
 *     }
 *     @case['starttls']{
 *       Upgrade to TLS after establishing a plaintext connection.  Abort if
 *       the server seems incapable of performing the upgrade.
 *     }
 *     @case[true]{
 *       Establish a TLS connection from the get-go; never use plaintext at all.
 *       By convention this may be referred to as an SSL or SSL/TLS connection.
 *     }
 * ]]
 * @typedef[AccountCredentials @dict[
 *   @key[username String]{
 *     The name we use to identify ourselves to the server.  This will
 *     frequently be the whole e-mail address.  Ex: "joe@example.com" rather
 *     than just "joe".
 *   }
 *   @key[password String]{
 *     The password.  Ideally we would have a keychain mechanism so we wouldn't
 *     need to store it like this.
 *   }
 * ]]
 * @typedef[IdentityDef @dict[
 *   @key[name String]{
 *     Display name, ex: "Joe User".
 *   }
 *   @key[address String]{
 *     E-mail address, ex: "joe@example.com".
 *   }
 *   @key[replyTo @oneof[null String]]{
 *     The e-mail address to put in the "reply-to" header for recipients
 *     to address their replies to.  If null, the header will be omitted.
 *   }
 *   @key[signature @oneof[null String]]{
 *     An optional signature block.  If present, we ensure the body text ends
 *     with a newline by adding one if necessary, append "-- \n", then append
 *     the contents of the signature.  Once we start supporting HTML, we will
 *     need to indicate whether the signature is plaintext or HTML.  For now
 *     it must be plaintext.
 *   }
 * ]]
 * @typedef[AccountDef @dict[
 *   @key[id AccountId]
 *   @key[name String]{
 *     The display name for the account.
 *   }
 *   @key[identities @listof[IdentityDef]]
 *
 *   @key[type @oneof['imap+smtp' 'activesync']]
 *   @key[receiveType @oneof['imap' 'activesync']]
 *   @key[sendType @oneof['smtp' 'activesync']]
 *   @key[receiveConnInfo ConnInfo]
 *   @key[sendConnInfo ConnInfo]
 * ]]
 */
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
      for (var i = 0; i < accountInfos.length; i++) {
        var accountInfo = accountInfos[i];
        self._loadAccount(accountInfo.def, accountInfo.folderInfo);
      }
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
  tryToCreateAccount: function(userAndPass, callback) {
    var domain = userAndPass.username.substring(
                   userAndPass.username.indexOf('@') + 1),
        domainInfo = null, credentials, imapConnInfo, smtpConnInfo;
    if (autoconfigByDomain.hasOwnProperty(domain))
      domainInfo = autoconfigByDomain[domain];
    if (domainInfo) {
      var username = domainInfo.usernameIsFullEmail ? userAndPass.username
        : userAndPass.username.substring(0, userAndPass.username.indexOf('@'));
      credentials = {
        username: username,
        password: userAndPass.password,
      };
      imapConnInfo = {
        hostname: domainInfo.imapHost,
        port: domainInfo.imapPort,
        crypto: domainInfo.imapCrypto,
      };
      smtpConnInfo = {
        hostname: domainInfo.smtpHost,
        port: domainInfo.smtpPort,
        crypto: domainInfo.smtpCrypto,
      };
    }
    else {
      throw new Error("Don't know how to configure domain: " + domain);
    }

    var callbacks = allbackMaker(
      ['imap', 'smtp'],
      function probesDone(results) {
        // -- both good?
        if (results.imap[0] && results.smtp) {
          // The account is good, but it'll be boring without a list of folders.
          var imapAccount = self._createImapAccount(imapConnInfo,
                                                    results.imap[1]),
              smtpAccount = self._createSmtpAccount(smtpConnInfo);
          imapAccount.syncFolderList(function() {
            callback(accountGood, account);
          });

        }
        // -- either/both bad
        else {
          // clean up the imap connection if it was okay but smtp failed
          if (results.imap[0])
            results.imap[1].close();
          callback(false, null);
          return;
        }
      });

    var self = this;
    var imapProber = new $imapprobe.ImapProber(credentials, imapConnInfo);
    imapProber.onresult = callbacks.imap;

    var smtpProber = new $smtpprobe.SmtpProber(credentials, smtpConnInfo);
    smtpProber.onresult = callbacks.smtp;
  },

  /**
   * Define an account now that we have verified the credentials are good and
   * the server meets our minimal functionality standards.  We are also
   * provided with the protocol connection that was used to perform the check
   * so we can immediately put it to work.
   */
  _defineImapAccount: function(accountName, credentials,
                               imapConnInfo, smtpConnInfo,
                               imapProtoConn) {
    var accountDef = {
      id: $a64.encodeInt(this.config.nextAccountNum++),
      name: accountName,

      type: 'imap+smtp',
      receiveType: 'imap',
      sendType: 'smtp',

      credentials: credentials,
      receiveConnInfo: imapConnInfo,
      sendConnInfo: smtpConnInfo,
    };
    var folderInfo = {
      $meta: {
        nextFolderNum: 0,
      },
    };
    this._db.saveAccountDef(accountDef, folderInfo);
    this._loadAccount(accountDef, folderInfo, imapProtoConn);
  },

  /**
   * Instantiate an account from the persisted representation.
   */
  _loadAccount: function(accountDef, folderInfo, receiveProtoConn) {
    if (!COMPOSITE_ACCOUNT_TYPE_TO_CLASS.hasOwnProperty(accountDef.type)) {
      this._LOG.badAccountType(accountDef.type);
      return null;
    }
    // right now, we only have composite types, so everything below assumes it
    if (!PIECE_ACCOUNT_TYPE_TO_CLASS.hasOwnProperty(accountDef.receiveType)) {
      this._LOG.badAccountType(accountDef.receiveType);
    }
    if (!PIECE_ACCOUNT_TYPE_TO_CLASS.hasOwnProperty(accountDef.sendType)) {
      this._LOG.badAccountType(accountDef.sendType);
    }

    var receivePiece =
      new PIECE_ACCOUNT_TYPE_TO_CLASS[accountDef.receiveType](
        accountDef.id, accountDef.credentials, accountDef.receiveConnInfo,
        folderInfo, this._LOG, receiveProtoConn);
    var sendPiece =
      new PIECE_ACCOUNT_TYPE_TO_CLASS[accountDef.sendType](
        accountDef.id, accountDef.credentials,
        accountDef.sendConnInfo, this._LOG);
    var compositeAccount = new CompositeAccount(accountDef, receivePiece,
                                                sendPiece);

    var account = new $imapacct.ImapAccount(accountDef, folderInfo, this._LOG,
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

  getFolderStorageForFolderId: function(folderId) {
    var account = this.getAccountForFolderId(folderId);
    return account.getFolderStorageForId(folderId);
  },
};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  MailUniverse: {
    type: $log.ACCOUNT,
    events: {
      configLoaded: {},
      createAccount: { type: true, id: false },
    },
    TEST_ONLY_events: {
      configLoaded: { config: false },
      createAccount: { name: false },
    },
    errors: {
      badAccountType: { type: true },
    },
  },
});

}); // end define
