/**
 *
 **/

define(
  [
    'rdcommon/log',
    'rdcommon/logreaper',
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
    $logreaper,
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

/**
 * How many operations per account should we track to allow for undo operations?
 * The B2G email app only demands a history of 1 high-level op for undoing, but
 * we are supporting somewhat more for unit tests, potential fancier UIs, and
 * because high-level ops may end up decomposing into multiple lower-level ops
 * someday.
 *
 * This limit obviously is not used to discard operations not yet performed!
 */
const MAX_MUTATIONS_FOR_UNDO = 10;

const PIECE_ACCOUNT_TYPE_TO_CLASS = {
  'imap': $imapacct.ImapAccount,
  'smtp': $smtpacct.SmtpAccount,
  //'gmail-imap': GmailAccount,
};

// A boring signature that conveys the person was probably typing on a touch
// screen, helping to explain typos and short replies.
const DEFAULT_SIGNATURE = exports.DEFAULT_SIGNATURE =
  'Sent from my Firefox OS device.';

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

  // Currently we don't persist the disabled state of an account because it's
  // easier for the UI to be edge-triggered right now and ensure that the
  // triggering occurs once each session.
  this.enabled = true;
  this.problems = [];

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
      universe, this,
      accountDef.id, accountDef.credentials, accountDef.receiveConnInfo,
      folderInfo, dbConn, this._LOG, receiveProtoConn);
  this._sendPiece =
    new PIECE_ACCOUNT_TYPE_TO_CLASS[accountDef.sendType](
      universe, this,
      accountDef.id, accountDef.credentials,
      accountDef.sendConnInfo, dbConn, this._LOG);

  // expose public lists that are always manipulated in place.
  this.folders = this._receivePiece.folders;
  this.meta = this._receivePiece.meta;
  this.mutations = this._receivePiece.mutations;
}
CompositeAccount.prototype = {
  toString: function() {
    return '[CompositeAccount: ' + this.id + ']';
  },
  toBridgeWire: function() {
    return {
      id: this.accountDef.id,
      name: this.accountDef.name,
      type: this.accountDef.type,

      enabled: this.enabled,
      problems: this.problems,

      identities: this.identities,

      credentials: {
        username: this.accountDef.credentials.username,
        // no need to send the password to the UI.
      },

      servers: [
        {
          type: this.accountDef.receiveType,
          connInfo: this.accountDef.receiveConnInfo,
          activeConns: this._receivePiece.numActiveConns,
        },
        {
          type: this.accountDef.sendType,
          connInfo: this.accountDef.sendConnInfo,
          activeConns: this._sendPiece.numActiveConns,
        }
      ],
    };
  },
  toBridgeFolder: function() {
    return {
      id: this.accountDef.id,
      name: this.accountDef.name,
      path: this.accountDef.name,
      type: 'account',
    };
  },

  saveAccountState: function(reuseTrans) {
    return this._receivePiece.saveAccountState(reuseTrans);
  },

  /**
   * Check that the account is healthy in that we can login at all.
   */
  checkAccount: function(callback) {
    // Since we use the same credential for both cases, we can just have the
    // IMAP account attempt to establish a connection and forget about SMTP.
    this._receivePiece.checkAccount(callback);
  },

  /**
   * Shutdown the account; see `MailUniverse.shutdown` for semantics.
   */
  shutdown: function() {
    this._sendPiece.shutdown();
    this._receivePiece.shutdown();
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

  runOp: function(op, mode, callback) {
    return this._receivePiece.runOp(op, mode, callback);
  },
};

const COMPOSITE_ACCOUNT_TYPE_TO_CLASS = {
  'imap+smtp': CompositeAccount,
  'fake': $fakeacct.FakeAccount,
};


// Simple hard-coded autoconfiguration by domain...
var autoconfigByDomain = {
  // this is for testing, and won't work because of bad certs.
  'asutherland.org': {
    type: 'imap+smtp',
    imapHost: 'mail.asutherland.org',
    imapPort: 993,
    imapCrypto: true,
    smtpHost: 'mail.asutherland.org',
    smtpPort: 465,
    smtpCrypto: true,
    usernameIsFullEmail: true,
  },
  'mozilla.com': {
    type: 'imap+smtp',
    imapHost: 'mail.mozilla.com',
    imapPort: 993,
    imapCrypto: true,
    smtpHost: 'smtp.mozilla.org',
    smtpPort: 465,
    smtpCrypto: true,
    usernameIsFullEmail: true,
  },
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
  'slocalhost': {
    type: 'imap+smtp',
    imapHost: 'localhost',
    imapPort: 993,
    imapCrypto: true,
    smtpHost: 'localhost',
    smtpPort: 465,
    smtpCrypto: true,
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
        nextMutationNum: 0,
        lastFullFolderProbeAt: 0,
        capability: imapProtoConn.capabilities,
        rootDelim: imapProtoConn.delim,
      },
      $mutations: [],
    };
    universe.saveAccountDef(accountDef, folderInfo);
    return universe._loadAccount(accountDef, folderInfo, imapProtoConn);
  },
};
Configurators['fake'] = {
  tryToCreateAccount: function cfg_fake(universe, userDetails, domainInfo,
                                        callback, _LOG) {
    var credentials = {
      username: userDetails.emailAddress,
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
      $meta: {
        nextMutationNum: 0,
      },
      $mutations: [],
    };
    universe.saveAccountDef(accountDef, folderInfo);
    var account = universe._loadAccount(accountDef, folderInfo, null);
    callback(true, account);
  },
};

/**
 * When debug logging is enabled, how many second's worth of samples should
 * we keep?
 */
const MAX_LOG_BACKLOG = 30;

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
 * @typedef[UniverseConfig @dict[
 *   @key[nextAccountNum Number]
 *   @key[nextIdentityNum Number]
 *   @key[debugLogging Boolean]{
 *     Has logging been turned on for debug purposes?
 *   }
 * ]]{
 *   The configuration fields stored in the database.
 * }
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
 * @typedef[MessageNamer @dict[
 *   @key[date DateMS]
 *   @key[suid SUID]
 * ]]{
 *   The information we need to locate a message within our storage.  When the
 *   MailAPI tells the back-end things, it uses this representation.
 * }
 * @typedef[SerializedMutation @dict[
 *   @key[type @oneof[
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
 *   @key[longtermId]{
 *     Unique-ish identifier for the mutation.  Just needs to be unique enough
 *     to not refer to any pending or still undoable-operation.
 *   }
 *   @key[status @oneof[
 *     @case[null]
 *     @case['running']
 *     @case['done']
 *   ]]{
 *   }
 *   @key[humanOp String]{
 *     The user friendly opcode where flag manipulations like starring have
 *     their own opcode.
 *   }
 *   @key[messages @listof[MessageNamer]]
 *
 *   @key[folderId #:optional FolderId]{
 *     If this is a move/copy, the target folder
 *   }
 * ]]
 */
function MailUniverse(callAfterBigBang) {
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
  this.online = true; // just so we don't cause an offline->online transition
  this._onConnectionChange();
  connection.addEventListener('change', this._onConnectionChange.bind(this));

  this._testModeDisablingLocalOps = false;

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
  this._logReaper = null;
  this._logBacklog = null;

  this._LOG = null;
  this._db = new $imapdb.ImapDB();
  var self = this;
  this._db.getConfig(function(configObj, accountInfos) {
    if (configObj) {
      self.config = configObj;
      if (self.config.debugLogging) {
        console.warn("GENERAL LOGGING ENABLED!");
        console.warn("(CIRCULAR EVENT LOGGING WITH NON-SENSITIVE DATA)");
        $log.enableGeneralLogging();
      }
      self._LOG = LOGFAB.MailUniverse(this, null, null);
      if (self.config.debugLogging)
        self._enableCircularLogging();

      self._LOG.configLoaded(self.config, accountInfos);

      for (var i = 0; i < accountInfos.length; i++) {
        var accountInfo = accountInfos[i];
        self._loadAccount(accountInfo.def, accountInfo.folderInfo);
      }
    }
    else {
      self._LOG = LOGFAB.MailUniverse(this, null, null);
      self.config = {
        // We need to put the id in here because our startup query can't
        // efficiently get both the key name and the value, just the values.
        id: 'config',
        nextAccountNum: 0,
        nextIdentityNum: 0,
        debugLogging: false,
      };
      self._db.saveConfig(self.config);
    }
    callAfterBigBang();
  });
}
exports.MailUniverse = MailUniverse;
MailUniverse.prototype = {
  //////////////////////////////////////////////////////////////////////////////
  // Logging
  _enableCircularLogging: function() {
    this._logReaper = new $logreaper.LogReaper(this._LOG);
    this._logBacklog = [];
    window.setInterval(
      function() {
        var logTimeSlice = this._logReaper.reapHierLogTimeSlice();
        // if nothing interesting happened, this could be empty, yos.
        if (logTimeSlice.logFrag) {
          this._logBacklog.push(logTimeSlice);
          // throw something away if we've got too much stuff already
          if (this._logBacklog.length > MAX_LOG_BACKLOG)
            this._logBacklog.shift();
        }
      }.bind(this),
      1000);
  },

  createLogBacklogRep: function(id) {
    return {
      type: 'backlog',
      id: id,
      schema: $log.provideSchemaForAllKnownFabs(),
      backlog: this._logBacklog,
    };
  },

  dumpLogToDeviceStorage: function() {
    console.log('Planning to dump log to device storage for "pictures"');
    try {
      // 'default' does not work, but pictures does.  Hopefully gallery is
      // smart enough to stay away from my log files!
      var storage = navigator.getDeviceStorage('pictures')[0];
      var blob = new Blob([JSON.stringify(this.createLogBacklogRep())],
                          {
                            type: 'application/json',
                            endings: 'transparent'
                          });
      var filename = 'gem-log-' + Date.now() + '.json';
      var req = storage.addNamed(blob, filename);
      req.onsuccess = function() {
        console.log('saved log to', filename);
      };
      req.onerror = function() {
        console.error('failed to save log to', filename);
      };
    }
    catch(ex) {
      console.error('Problem dumping log to device storage:', ex,
                    '\n', ex.stack);
    }
  },

  //////////////////////////////////////////////////////////////////////////////
  // Config / Settings

  /**
   * Return the subset of our configuration that the client can know about.
   */
  exposeConfigForClient: function() {
    // eventually, iterate over a whitelist, but for now, it's easy...
    return {
      debugLogging: this.config.debugLogging,
    };
  },

  modifyConfig: function(changes) {
    for (var key in changes) {
      this.config[key] = changes[key];
    }
    this._db.saveConfig(this.config);
  },

  //////////////////////////////////////////////////////////////////////////////
  _onConnectionChange: function() {
    var connection = window.navigator.connection ||
                       window.navigator.mozConnection ||
                       window.navigator.webkitConnection;
    var wasOnline = this.online;
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

    if (!wasOnline && this.online) {
      // - check if we have any pending actions to run and run them if so.
      for (var iAcct = 0; iAcct < this.accounts.length; iAcct++) {
        this._resumeOpProcessingForAccount(this.accounts[iAcct]);
      }
    }
  },

  /**
   * Start processing ops for an account if it's able and has ops to run.
   */
  _resumeOpProcessingForAccount: function(account) {
    var queue = this._opsByAccount[account.id];
    if (!account.enabled)
      return;
    if (queue.length &&
        // (it's possible there is still an active job right now)
        (queue[0].status !== 'doing' && queue[0].status !== 'undoing')) {
      var op = queue[0];
      account.runOp(
        op, op.desire,
        this._opCompleted.bind(this, account, op));
    }
  },

  registerBridge: function(mailBridge) {
    this._bridges.push(mailBridge);
  },

  unregisterBridge: function(mailBridge) {
    var idx = this._bridges.indexOf(mailBridge);
    if (idx !== -1)
      this._bridges.splice(idx, 1);
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
   * Shutdown the account, forget about it, nuke associated database entries.
   */
  deleteAccount: function(accountId) {
    var savedEx = null;
    var account = this._accountsById[accountId];
    try {
      account.shutdown();
    }
    catch (ex) {
      // save the failure until after we have done other cleanup.
      savedEx = ex;
    }
    this._db.deleteAccount(accountId);

    delete this._accountsById[accountId];
    var idx = this.accounts.indexOf(account);
    this.accounts.splice(idx, 1);

    for (var i = 0; i < account.identities.length; i++) {
      var identity = account.identities[i];
      idx = this.identities.indexOf(identity);
      this.identities.splice(idx, 1);
      delete this._identitiesById[identity.id];
    }

    delete this._opsByAccount[accountId];
    delete this._opCompletionListenersByAccount[accountId];

    this.__notifyRemovedAccount(accountId);

    if (savedEx)
      throw savedEx;
  },

  saveAccountDef: function(accountDef, folderInfo) {
    this._db.saveAccountDef(this.config, accountDef, folderInfo);
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

    this.__notifyAddedAccount(account);

    // - check for mutations that still need to be processed
    for (var i = 0; i < account.mutations.length; i++) {
      var op = account.mutations[i];
      if (op.desire)
        this._queueAccountOp(account, op);
    }

    return account;
  },

  /**
   * Self-reporting by an account that it is experiencing difficulties.
   *
   * We mutate its state for it, and generate a notification if this is a new
   * problem.
   */
  __reportAccountProblem: function(account, problem) {
    // nothing to do if the problem is already known
    if (account.problems.indexOf(problem) !== -1)
      return;
    account.problems.push(problem);
    account.enabled = false;

    if (problem === 'bad-user-or-pass')
      this.__notifyBadLogin(account);
  },

  clearAccountProblems: function(account) {
    // TODO: this would be a great time to have any slices that had stalled
    // syncs do whatever it takes to make them happen again.
    account.enabled = true;
    account.problems = [];
    this._resumeOpProcessingForAccount(account);
  },

  __notifyBadLogin: function(account) {
    for (var iBridge = 0; iBridge < this._bridges.length; iBridge++) {
      var bridge = this._bridges[iBridge];
      bridge.notifyBadLogin(account);
    }
  },

  __notifyAddedAccount: function(account) {
    for (var iBridge = 0; iBridge < this._bridges.length; iBridge++) {
      var bridge = this._bridges[iBridge];
      bridge.notifyAccountAdded(account);
    }
  },

  __notifyRemovedAccount: function(accountId) {
    for (var iBridge = 0; iBridge < this._bridges.length; iBridge++) {
      var bridge = this._bridges[iBridge];
      bridge.notifyAccountRemoved(accountId);
    }
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
  // Lifetime Stuff

  /**
   * Write the current state of the universe to the database.
   */
  saveUniverseState: function() {
    var curTrans = null;

    for (var iAcct = 0; iAcct < this.accounts.length; iAcct++) {
      var account = this.accounts[iAcct];
      curTrans = account.saveAccountState(curTrans);
    }
  },

  /**
   * Shutdown all accounts; this is currently for the benefit of unit testing.
   * We expect our app to operate in a crash-only mode of operation where a
   * clean shutdown means we get a heads-up, put ourselves offline, and trigger a
   * state save before we just demand that our page be closed.  That's future
   * work, of course.
   */
  shutdown: function() {
    for (var iAcct = 0; iAcct < this.accounts.length; iAcct++) {
      var account = this.accounts[iAcct];
      account.shutdown();
    }
    this._db.close();
    this._LOG.__die();
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

  getFolderStorageForMessageSuid: function mu_getFolderStorageForFolderId(
                                    messageSuid) {
    var folderId = messageSuid.substring(0, messageSuid.lastIndexOf('/')),
        account = this.getAccountForFolderId(folderId);
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

  /**
   * Partitions messages by account.  Accounts may want to partition things
   * further, such as by folder, but we leave that up to them since not all
   * may require it.  (Ex: activesync and gmail may be able to do things
   * that way.)
   */
  _partitionMessagesByAccount: function(messageNamers, targetAccountId) {
    var results = [], acctToMsgs = {};

    for (var i = 0; i < messageNamers.length; i++) {
      var messageNamer = messageNamers[i],
          messageSuid = messageNamer.suid,
          accountId = messageSuid.substring(0, messageSuid.indexOf('/'));
      if (!acctToMsgs.hasOwnProperty(accountId)) {
        var messages = [messageNamer];
        results.push({
          account: this._accountsById[accountId],
          messages: messages,
          crossAccount: (targetAccountId && targetAccountId !== accountId),
        });
        acctToMsgs[accountId] = messages;
      }
      else {
        acctToMsgs[accountId].push(messageNamer);
      }
    }

    return results;
  },

  _opCompleted: function(account, op, err) {
    // Clear the desire if it is satisfied.  It's possible the desire is now
    // to undo it, in which case we don't want to clobber the undo desire with
    // the completion of the do desire.
    if (op.status === 'done' && op.desire === 'do')
      op.desire = null;
    else if (op.status === 'undone' && op.desire === 'undo')
      op.desire = null;
    var queue = this._opsByAccount[account.id];
    // shift the running op off.
    queue.shift();

    if (queue.length && this.online && account.enabled) {
      op = queue[0];
      account.runOp(
        op, op.desire,
        this._opCompleted.bind(this, account, op));
    }
    else if (this._opCompletionListenersByAccount[account.id]) {
      this._opCompletionListenersByAccount[account.id](account);
      this._opCompletionListenersByAccount[account.id] = null;
    }
  },

  /**
   * Immediately run the local mutation (synchronously) for an operation and
   * enqueue its server operation for asynchronous operation.
   *
   * (nb: Header updates' execution may actually be deferred into the future if
   * block loads are required, but they will maintain their apparent ordering
   * on the folder in question.)
   */
  _queueAccountOp: function(account, op) {
    var queue = this._opsByAccount[account.id];
    queue.push(op);

    if (op.longtermId === null) {
      op.longtermId = account.id + '/' +
                        $a64.encodeInt(account.meta.nextMutationNum++);
      account.mutations.push(op);
      while (account.mutations.length > MAX_MUTATIONS_FOR_UNDO &&
             account.mutations[0].desire === null) {
        account.mutations.shift();
      }
    }

    // - run the local manipulation immediately
    if (!this._testModeDisablingLocalOps)
      account.runOp(op, op.desire === 'do' ? 'local_do' : 'local_undo');

    // - initiate async execution if this is the first op
    if (this.online && account.enabled && queue.length === 1)
      account.runOp(
        op, op.desire,
        this._opCompleted.bind(this, account, op));
    return op.longtermId;
  },

  waitForAccountOps: function(account, callback) {
    if (this._opsByAccount[account.id].length === 0)
      callback();
    else
      this._opCompletionListenersByAccount[account.id] = callback;
  },

  modifyMessageTags: function(humanOp, messageSuids, addTags, removeTags) {
    var self = this, longtermIds = [];
    this._partitionMessagesByAccount(messageSuids, null).forEach(function(x) {
      var longtermId = self._queueAccountOp(
        x.account,
        {
          type: 'modtags',
          longtermId: null,
          status: null,
          desire: 'do',
          humanOp: humanOp,
          messages: x.messages,
          addTags: addTags,
          removeTags: removeTags,
          // how many messages have had their tags changed already.
          progress: 0,
        });
      longtermIds.push(longtermId);
    });
    return longtermIds;
  },

  moveMessages: function(messageSuids, targetFolderId) {
  },

  appendMessages: function(folderId, messages) {
    var account = this.getAccountForFolderId(folderId);
    var longtermId = this._queueAccountOp(
      account,
      {
        type: 'append',
        longtermId: null,
        status: null,
        desire: 'do',
        humanOp: 'append',
        messages: messages,
        folderId: folderId,
      });
    return [longtermId];
  },

  undoMutation: function(longtermIds) {
    for (var i = 0; i < longtermIds.length; i++) {
      var longtermId = longtermIds[i],
          account = this.getAccountForFolderId(longtermId); // (it's fine)

      for (var iOp = 0; iOp < account.mutations.length; iOp++) {
        var op = account.mutations[iOp];
        if (op.longtermId === longtermId) {
          switch (op.status) {
            // if we haven't started doing the operation, we can cancel it
            case null:
            case 'undone':
              var queue = this._opsByAccount[account.id],
                  idx = queue.indexOf(op);
              if (idx !== -1) {
                queue.splice(idx, 1);
                // we still need to trigger the local_undo, of course
                account.runOp(op, 'local_undo');
                op.desire = null;
              }
              // If it somehow didn't exist, enqueue it.  Presumably this is
              // something odd like a second undo request, which is logically
              // a 'do' request, which is unsupported, but hey.
              else {
                op.desire = 'do';
                this._queueAccountOp(account, op);
              }
              break;
            // If it has been completed or is in the processing of happening, we
            // should just enqueue it again to trigger its undoing/doing.
            case 'done':
            case 'doing':
              op.desire = 'undo';
              this._queueAccountOp(account, op);
              break;
            case 'undoing':
              op.desire = 'do';
              this._queueAccountOp(account, op);
              break;
          }
        }
      }
    }
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
      configLoaded: { config: false, accounts: false },
      createAccount: { name: false },
    },
    errors: {
      badAccountType: { type: true },
    },
  },
});

}); // end define
