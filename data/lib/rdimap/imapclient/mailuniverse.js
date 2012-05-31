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
    './fakeacct',
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
    $fakeacct,
    $module,
    exports
  ) {
const allbackMaker = $allback.allbackMaker;

const PIECE_ACCOUNT_TYPE_TO_CLASS = {
  'imap': $imapacct.ImapAccount,
  'smtp': $smtpacct.SmtpAccount,
  //'gmail-imap': GmailAccount,
};

// So, I want to poke fun at the iPhone signature, although we know there is
// also the flip side of explaining brevity, rampant typos, limited attention
// due to driving/flying a plane/other-dangerous-thing while using it.
const DEFAULT_SIGNATURE = [
  "Sent from my B2G phone.  That's right.  I've got one.",
].join("\n");

/**
 * Composite account type to expose account piece types with individual
 * implementations (ex: imap, smtp) together as a single account.  This is
 * intended to be a very thin layer that shields consuming code from the
 * fact that IMAP and SMTP are not actually bundled tightly together.
 */
function CompositeAccount(universe, accountDef, folderInfo, dbConn,
                          receiveProtoConn,
                          _LOG) {
  this.universe = universe;
  this.id = accountDef.id;
  this.accountDef = accountDef;
  // XXX for now we are stealing the universe's logger
  this._LOG = _LOG;

  this.identities = accountDef.identities;

  if (!PIECE_ACCOUNT_TYPE_TO_CLASS.hasOwnProperty(accountDef.receiveType)) {
    this._LOG.badAccountType(accountDef.receiveType);
  }
  if (!PIECE_ACCOUNT_TYPE_TO_CLASS.hasOwnProperty(accountDef.sendType)) {
    this._LOG.badAccountType(accountDef.sendType);
  }

  this._receivePiece =
    new PIECE_ACCOUNT_TYPE_TO_CLASS[accountDef.receiveType](
      universe,
      accountDef.id, accountDef.credentials, accountDef.receiveConnInfo,
      folderInfo, dbConn, this._LOG, receiveProtoConn);
  this._sendPiece =
    new PIECE_ACCOUNT_TYPE_TO_CLASS[accountDef.sendType](
      universe,
      accountDef.id, accountDef.credentials,
      accountDef.sendConnInfo, dbConn, this._LOG);

  // expose public lists that are always manipulated in place.
  this.folders = this._receivePiece.folders;
}
CompositeAccount.prototype = {
  toString: function() {
    return '[CompositeAccount: ' + this.id + ']';
  },
  toBridgeWire: function() {
    return {
      id: this.accountDef.id,
      name: this.accountDef.name,
      path: this.accountDef.name, // allows it to masquerade as a folder
      type: this.accountDef.type,

      identities: this.identities,

      credentials: {
        username: this.accountDef.credentials.username,
        // no need to send the password to the UI.
      },

      servers: [
        {
          type: this.accountDef.receiveType,
          connInfo: this.accountDef.receiveConnInfo,
        },
        {
          type: this.accountDef.sendType,
          connInfo: this.accountDef.sendConnInfo,
        }
      ],
    };
  },

  createFolder: function(parentFolderId, folderName, containOnlyOtherFolders,
                         callback) {
    return this._receivePiece.createFolder(
      parentFolderId, folderName, containOnlyOtherFolders, callback);
  },

  deleteFolder: function(folderId, callback) {
    return this._receivePiece.deleteFolder(folderId, callback);
  },

  sliceFolderMessages: function(folderId, bridgeProxy) {
    return this._receivePiece.sliceFolderMessages(folderId, bridgeProxy);
  },

  syncFolderList: function(callback) {
    return this._receivePiece.syncFolderList(callback);
  },

  sendMessage: function(composedMessage, callback) {
    return this._sendPiece.sendMessage(composedMessage, callback);
  },

  getFolderStorageForFolderId: function(folderId) {
    return this._receivePiece.getFolderStorageForFolderId(folderId);
  },

  runOp: function(op, callback) {
    return this._receivePiece.runOp(op, callback);
  },
};

const COMPOSITE_ACCOUNT_TYPE_TO_CLASS = {
  'imap+smtp': CompositeAccount,
  'fake': $fakeacct.FakeAccount,
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
  'example.com': {
    type: 'fake',
  },
};

var Configurators = {};
Configurators['imap+smtp'] = {
  tryToCreateAccount: function cfg_is_ttca(universe, userDetails, domainInfo,
                                           callback, _LOG) {
    var credentials, imapConnInfo, smtpConnInfo;
    if (domainInfo) {
      var username = domainInfo.usernameIsFullEmail ? userDetails.emailAddress
        : userDetails.emailAddress.substring(
            0, userDetails.emailAddress.indexOf('@'));
      credentials = {
        username: username,
        password: userDetails.password,
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

    var self = this;
    var callbacks = allbackMaker(
      ['imap', 'smtp'],
      function probesDone(results) {
        // -- both good?
        if (results.imap[0] && results.smtp) {
          var account = self._defineImapAccount(
            universe,
            userDetails, credentials,
            imapConnInfo, smtpConnInfo, results.imap[1]);
          account.syncFolderList(function() {
            callback(true, account);
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

    var imapProber = new $imapprobe.ImapProber(credentials, imapConnInfo,
                                               _LOG);
    imapProber.onresult = callbacks.imap;

    var smtpProber = new $smtpprobe.SmtpProber(credentials, smtpConnInfo,
                                               _LOG);
    smtpProber.onresult = callbacks.smtp;
  },

  /**
   * Define an account now that we have verified the credentials are good and
   * the server meets our minimal functionality standards.  We are also
   * provided with the protocol connection that was used to perform the check
   * so we can immediately put it to work.
   */
  _defineImapAccount: function cfg_is__defineImapAccount(
                        universe,
                        userDetails, credentials, imapConnInfo, smtpConnInfo,
                        imapProtoConn) {
    var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
    var accountDef = {
      id: accountId,
      name: userDetails.emailAddress,

      type: 'imap+smtp',
      receiveType: 'imap',
      sendType: 'smtp',

      credentials: credentials,
      receiveConnInfo: imapConnInfo,
      sendConnInfo: smtpConnInfo,

      identities: [
        {
          id: accountId + '/' +
                $a64.encodeInt(universe.config.nextIdentityNum++),
          name: userDetails.displayName,
          address: userDetails.emailAddress,
          replyTo: null,
          signature: DEFAULT_SIGNATURE
        },
      ]
    };
    var folderInfo = {
      $meta: {
        nextFolderNum: 0,
      },
      $mutations: [],
    };
    universe._db.saveAccountDef(accountDef, folderInfo);
    return universe._loadAccount(accountDef, folderInfo, imapProtoConn);
  },
};
Configurators['fake'] = {
  tryToCreateAccount: function cfg_fake(universe, userDetails, domainInfo,
                                        callback, _LOG) {
    var credentials = {
      username: userDetails.username,
      password: userDetails.password,
    };
    var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
    var accountDef = {
      id: accountId,
      name: userDetails.emailAddress,

      type: 'fake',

      credentials: credentials,
      connInfo: {
        hostname: 'magic.example.com',
        port: 1337,
        crypto: true,
      },

      identities: [
        {
          id: accountId + '/' +
                $a64.encodeInt(universe.config.nextIdentityNum++),
          name: userDetails.displayName,
          address: userDetails.emailAddress,
          replyTo: null,
          signature: DEFAULT_SIGNATURE
        },
      ]
    };

    var folderInfo = {
      $mutations: [],
    };
    universe._db.saveAccountDef(accountDef, folderInfo);
    var account = universe._loadAccount(accountDef, folderInfo, null);
    callback(true, account);
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
 *   @key[id String]{
 *     Unique identifier resembling folder id's;
 *     "{account id}-{unique value for this account}" is what it looks like.
 *   }
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
 * @typedef[SerializedMutation @dict[
 *   @key[id]{
 *     Unique-ish identifier for the mutation.  Just needs to be unique enough
 *     to not refer to any pending or still undoable-operation.
 *   }
 *   @key[friendlyOp String]{
 *     The user friendly opcode where flag manipulations like starring have
 *     their own opcode.
 *   }
 *   @key[realOp @oneof[
 *     @case['modtags']{
 *       Modify tags by adding and/or removing them.
 *     }
 *     @case['delete']{
 *     }
 *     @case['move']{
 *       Move message(s) within the same account.
 *     }
 *     @case['copy']{
 *       Copy message(s) within the same account.
 *     }
 *   ]]{
 *     The implementation opcode used to determine what functions to call.
 *   }
 *   @key[messages @listof[SUID]]
 *   @key[targetFolder #:optional FolderId]{
 *     If this is a move/copy, the target folder
 *   }
 * ]]
 */
function MailUniverse(testingModeLogData, callAfterBigBang) {
  /** @listof[CompositeAccount] */
  this.accounts = [];
  this._accountsById = {};

  /** @listof[IdentityDef] */
  this.identities = [];
  this._identitiesById = {};

  this._opsByAccount = {};
  this._opCompletionListenersByAccount = {};

  this._bridges = [];

  // hookup network status indication
  var connection = window.navigator.connection ||
                     window.navigator.mozConnection ||
                     window.navigator.webkitConnection;
  this._onConnectionChange();
  connection.addEventListener('change', this._onConnectionChange.bind(this));

  /**
   * @dictof[
   *   @key[AccountId]
   *   @value[@listof[SerializedMutation]]
   * ]{
   *   The list of mutations for the account that still have yet to complete.
   * }
   */
  this._pendingMutationsByAcct = {};

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
        nextIdentityNum: 0,
      };
    }
    callAfterBigBang();
  });
}
exports.MailUniverse = MailUniverse;
MailUniverse.prototype = {
  _onConnectionChange: function() {
    var connection = window.navigator.connection ||
                       window.navigator.mozConnection ||
                       window.navigator.webkitConnection;
    /**
     * Are we online?  AKA do we have actual internet network connectivity.
     * This should ideally be false behind a captive portal.
     */
    this.online = connection.bandwidth > 0;
    /**
     * Do we want to minimize network usage?  Right now, this is the same as
     * metered, but it's conceivable we might also want to set this if the
     * battery is low, we want to avoid stealing network/cpu from other
     * apps, etc.
     */
    this.minimizeNetworkUsage = connection.metered;
    /**
     * Is there a marginal cost to network usage?  This is intended to be used
     * for UI (decision) purposes where we may want to prompt before doing
     * things when bandwidth is metered, but not when the user is on comparably
     * infinite wi-fi.
     */
    this.networkCostsMoney = connection.metered;
  },

  tryToCreateAccount: function mu_tryToCreateAccount(userDetails, callback) {
    var domain = userDetails.emailAddress.substring(
                   userDetails.emailAddress.indexOf('@') + 1),
        domainInfo = null;

    if (autoconfigByDomain.hasOwnProperty(domain))
      domainInfo = autoconfigByDomain[domain];

    if (!domainInfo) {
      throw new Error("Don't know how to configure domain: " + domain);
    }

    var configurator = Configurators[domainInfo.type];
    return configurator.tryToCreateAccount(this, userDetails, domainInfo,
                                           callback, this._LOG);
  },

  /**
   * Instantiate an account from the persisted representation.
   */
  _loadAccount: function mu__loadAccount(accountDef, folderInfo,
                                         receiveProtoConn) {
    if (!COMPOSITE_ACCOUNT_TYPE_TO_CLASS.hasOwnProperty(accountDef.type)) {
      this._LOG.badAccountType(accountDef.type);
      return null;
    }
    var constructor = COMPOSITE_ACCOUNT_TYPE_TO_CLASS[accountDef.type];
    var account = new constructor(this, accountDef, folderInfo, this._db,
                                  receiveProtoConn, this._LOG);

    this.accounts.push(account);
    this._accountsById[account.id] = account;
    this._opsByAccount[account.id] = [];
    this._opCompletionListenersByAccount[account.id] = null;

    for (var iIdent = 0; iIdent < accountDef.identities.length; iIdent++) {
      var identity = accountDef.identities[iIdent];
      this.identities.push(identity);
      this._identitiesById[identity.id] = identity;
    }

    return account;
  },

  __notifyAddedFolder: function(accountId, folderMeta) {
    for (var iBridge = 0; iBridge < this._bridges.length; iBridge++) {
      var bridge = this._bridges[iBridge];
      bridge.notifyFolderAdded(accountId, folderMeta);
    }
  },

  __notifyRemovedFolder: function(accountId, folderMeta) {
    for (var iBridge = 0; iBridge < this._bridges.length; iBridge++) {
      var bridge = this._bridges[iBridge];
      bridge.notifyFolderRemoved(accountId, folderMeta);
    }
  },

  //////////////////////////////////////////////////////////////////////////////
  // Lookups: Account, Folder, Identity

  getAccountForAccountId: function mu_getAccountForAccountId(accountId) {
    return this._accountsById[accountId];
  },

  /**
   * Given a folder-id, get the owning account.
   */
  getAccountForFolderId: function mu_getAccountForFolderId(folderId) {
    var accountId = folderId.substring(0, folderId.indexOf('/')),
        account = this._accountsById[accountId];
    return account;
  },

  /**
   * Given a message's sufficiently unique identifier, get the owning account.
   */
  getAccountForMessageSuid: function mu_getAccountForMessageSuid(messageSuid) {
    var accountId = messageSuid.substring(0, messageSuid.indexOf('/')),
        account = this._accountsById[accountId];
    return account;
  },

  getFolderStorageForFolderId: function mu_getFolderStorageForFolderId(
                                 folderId) {
    var account = this.getAccountForFolderId(folderId);
    return account.getFolderStorageForFolderId(folderId);
  },

  getAccountForSenderIdentityId: function mu_getAccountForSenderIdentityId(
                                   identityId) {
    var accountId = identityId.substring(0, identityId.indexOf('/')),
        account = this._accountsById[accountId];
    return account;
  },

  getIdentityForSenderIdentityId: function mu_getIdentityForSenderIdentityId(
                                    identityId) {
    return this._identitiesById[identityId];
  },

  //////////////////////////////////////////////////////////////////////////////
  // Message Mutation and Undoing

  _partitionMessagesByAccount: function(messageSuids, targetAccountId) {
    var results = [], acctToMsgs = {};

    for (var i = 0; i < messageSuids.length; i++) {
      var messageSuid = messageSuids[0],
          accountId = messageSuid.substring(0, messageSuid.indexOf('/'));
      if (!acctToMsgs.hasOwnProperty(accountId)) {
        var messages = [messageSuid];
        results.push({
          account: this._accountsById[accountId],
          messages: messages,
          crossAccount: (targetAccountId && targetAccountId !== accountId),
        });
        acctToMsgs[accountId] = messages;
      }
      else {
        acctToMsgs[accountId].push(messageSuid);
      }
    }

    return results;
  },

  _opCompleted: function(account, op, err) {
    // shift the running op off.
    queue.shift();
  },

  _queueAccountOp: function(account, op) {
    var queue = this._opsByAccount[account.id];
    queue.push(op);
    if (queue.length === 1)
      account.runOp(op, this._opCompleted.bind(this, account, op));
  },

  waitForAccountOps: function(account, callback) {
    if (this._opsByAccount[account.id].length === 0)
      callback();
    else
      this._opCompletionListenersByAccount[account.id] = callback;
  },

  modifyMessageTags: function(messageSuids, addTags, removeTags) {
  },

  moveMessages: function(messageSuids, targetFolderId) {
  },

  undoMutation: function(mutationId) {
  },

  appendMessage: function(folderId, date, flags, messageText) {
    var account = this.getAccountForFolderId(folderId);
    this._queueAccountOp(
      account,
      {
        type: 'append',
        folderId: folderId,
        date: date,
        flags: flags,
        messageText: messageText,
      });
  },

  //////////////////////////////////////////////////////////////////////////////
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
