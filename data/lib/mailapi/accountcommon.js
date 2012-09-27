/**
 * Common code for creating and working with various account types.
 **/

define(
  [
    './a64',
    './allback',
    './imap/probe',
    './smtp/probe',
    'activesync/protocol',
    './imap/account',
    './smtp/account',
    './fake/account',
    './activesync/account',
    'exports'
  ],
  function(
    $a64,
    $allback,
    $imapprobe,
    $smtpprobe,
    $asproto,
    $imapacct,
    $smtpacct,
    $fakeacct,
    $asacct,
    exports
  ) {
const allbackMaker = $allback.allbackMaker;

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
exports.CompositeAccount = CompositeAccount;
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
  'activesync': $asacct.ActiveSyncAccount,
};

function accountTypeToClass(type) {
  if (!COMPOSITE_ACCOUNT_TYPE_TO_CLASS.hasOwnProperty(type))
    return null;
  return COMPOSITE_ACCOUNT_TYPE_TO_CLASS[type];
}
exports.accountTypeToClass = accountTypeToClass;

// Simple hard-coded autoconfiguration by domain...
var autoconfigByDomain = {
  'localhost': {
    type: 'imap+smtp',
    incoming: {
      hostname: 'localhost',
      port: 143,
      socketType: 'plain',
      username: '%EMAILLOCALPART%',
    },
    outgoing: {
      hostname: 'localhost',
      port: 25,
      socketType: 'plain',
      username: '%EMAILLOCALPART%',
    },
  },
  'slocalhost': {
    type: 'imap+smtp',
    incoming: {
      hostname: 'localhost',
      port: 993,
      socketType: 'SSL',
      username: '%EMAILLOCALPART%',
    },
    outgoing: {
      hostname: 'localhost',
      port: 465,
      socketType: 'SSL',
      username: '%EMAILLOCALPART%',
    },
  },
  // Mapping for a nonexistent domain for testing a bad domain without it being
  // detected ahead of time by the autoconfiguration logic or otherwise.
  'nonesuch.nonesuch': {
    type: 'imap+smtp',
    imapHost: 'nonesuch.nonesuch',
    imapPort: 993,
    imapCrypto: true,
    smtpHost: 'nonesuch.nonesuch',
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
      var emailLocalPart = userDetails.emailAddress.substring(
        0, userDetails.emailAddress.indexOf('@'));
      var username = domainInfo.incoming.username
        .replace('%EMAILADDRESS%', userDetails.emailAddress)
        .replace('%EMAILLOCALPART%', emailLocalPart);

      credentials = {
        username: username,
        password: userDetails.password,
      };
      imapConnInfo = {
        hostname: domainInfo.incoming.hostname,
        port: domainInfo.incoming.port,
        crypto: domainInfo.incoming.socketType === 'SSL',
      };
      smtpConnInfo = {
        hostname: domainInfo.outgoing.hostname,
        port: domainInfo.outgoing.port,
        crypto: domainInfo.outgoing.socketType === 'SSL',
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
            callback(null, account);
          });

        }
        // -- either/both bad
        else {
          // clean up the imap connection if it was okay but smtp failed
          if (results.imap[0])
            results.imap[1].close();
          callback('unknown', null);
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
      $deferredMutations: [],
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
      $deferredMutations: [],
    };
    universe.saveAccountDef(accountDef, folderInfo);
    var account = universe._loadAccount(accountDef, folderInfo, null);
    callback(null, account);
  },
};
Configurators['activesync'] = {
  tryToCreateAccount: function cfg_activesync(universe, userDetails, domainInfo,
                                              callback, _LOG) {
    var credentials = {
      username: userDetails.emailAddress,
      password: userDetails.password,
    };
    var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
    var accountDef = {
      id: accountId,
      name: userDetails.emailAddress,

      type: 'activesync',

      credentials: credentials,
      connInfo: null,

      identities: [
        {
          id: accountId + '/' +
                $a64.encodeInt(universe.config.nextIdentityNum++),
          name: userDetails.displayName || domainInfo.displayName,
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
        syncKey: '0',
      },
      $mutations: [],
      $deferredMutations: [],
    };

    var conn = new $asproto.Connection(credentials.username,
                                       credentials.password);
    conn.setServer(domainInfo.incoming.server);

    conn.connect(function(error, config, options) {
      // XXX: Think about what to do with this error handling, since it's
      // replicated in the autoconfig code.
      if (error) {
        var failureType = 'unknown';

        if (error instanceof $asproto.HttpError) {
          if (error.status === 401)
            failureType = 'bad-user-or-pass';
          else if (error.status === 403)
            failureType = 'not-authorized';
        }
        callback(failureType, null);
        return;
      }

      accountDef.connInfo = { server: config.selectedServer.url };
      if (!accountDef.identities[0].name && config.user)
        accountDef.identities[0].name = config.user.name;
      universe.saveAccountDef(accountDef, folderInfo);

      var account = universe._loadAccount(accountDef, folderInfo, conn);
      account.syncFolderList(function() {
        callback(null, account);
      });
    });
  },
};

function Autoconfigurator(_LOG) {
  this._LOG = _LOG;
}
exports.Autoconfigurator = Autoconfigurator;
Autoconfigurator.prototype = {
  _fatalErrors: ['bad-user-or-pass', 'not-authorized'],

  _isSuccessOrFatal: function(error) {
    return !error || this._fatalErrors.indexOf(error) !== -1;
  },

  // XXX: Go through these functions and make sure the callbacks provide
  // sufficiently useful error strings.

  _getXmlConfig: function getXmlConfig(url, callback) {
    let xhr = new XMLHttpRequest({mozSystem: true});
    xhr.open('GET', url, true);
    xhr.onload = function() {
      // XXX: For reasons which are currently unclear (possibly a platform
      // issue), trying to use responseXML results in a SecurityError when
      // running XPath queries. So let's just do an end-run around the
      // "security".
      let doc = new DOMParser().parseFromString(xhr.responseText, 'text/xml');
      function getNode(xpath, rel) {
        return doc.evaluate(xpath, rel || doc, null,
                            XPathResult.FIRST_ORDERED_NODE_TYPE, null)
                  .singleNodeValue;
      }

      let provider = getNode('/clientConfig/emailProvider');
      // Get the first incomingServer we can use (we assume first == best).
      let incoming = getNode('incomingServer[@type="imap"] | ' +
                             'incomingServer[@type="activesync"]', provider);
      let outgoing = getNode('outgoingServer[@type="smtp"]', provider);

      if (incoming) {
        let config = { type: null, incoming: {}, outgoing: {} };
        for (let [,child] in Iterator(incoming.children))
          config.incoming[child.tagName] = child.textContent;

        if (incoming.getAttribute('type') === 'activesync') {
          config.type = 'activesync';
          callback(null, config);
          return;
        }
        else if (outgoing) {
          config.type = 'imap+smtp';
          for (let [,child] in Iterator(outgoing.children))
            config.outgoing[child.tagName] = child.textContent;
          callback(null, config);
          return;
        }
      }

      callback('unknown');
    };
    xhr.onerror = function() { callback('unknown'); }

    xhr.send();
  },

  _getConfigFromLocalFile: function getConfigFromDB(domain, callback) {
    this._getXmlConfig('/autoconfig/' + encodeURIComponent(domain), callback);
  },

  _getConfigFromAutodiscover: function getConfigFromAutodiscover(userDetails,
                                                                 callback) {
    // XXX: We should think about how this function is implemented:
    // 1) Should we really create a Connection here? Maybe we want
    //    autodiscover() to be a free function.
    // 2) We're reimplementing jsas's "find the MobileSync server" code. Maybe
    //    that belongs in autodiscover() somehow.

    let conn = new $asproto.Connection(userDetails.emailAddress,
                                       userDetails.password);
    conn.autodiscover(function(error, config) {
      if (error) {
        var failureType = 'unknown';

        if (error instanceof $asproto.HttpError) {
          if (error.status === 401)
            failureType = 'bad-user-or-pass';
          else if (error.status === 403)
            failureType = 'not-authorized';
        }
        callback(failureType);
        return;
      }

      // Try to find a MobileSync server from Autodiscovery.
      for (let [,server] in Iterator(config.servers)) {
        if (server.type === 'MobileSync') {
          let autoconfig = {
            type: 'activesync',
            displayName: config.user.name,
            incoming: {
              server: server.url,
            },
          };

          return callback(null, autoconfig);
        }
      }

      return callback('unknown');
    });
  },

  _getConfigFromDomain: function getConfigFromDomain(userDetails, domain,
                                                     callback) {
    let suffix = '/mail/config-v1.1.xml?emailaddress=' +
                 encodeURIComponent(userDetails.emailAddress);
    let url = 'http://autoconfig.' + domain + suffix;
    let self = this;

    this._getXmlConfig(url, function(error, config) {
      if (self._isSuccessOrFatal(error))
        return callback(error, config);

      // See <http://tools.ietf.org/html/draft-nottingham-site-meta-04>.
      let url = 'http://' + domain + '/.well-known/autoconfig' + suffix;
      self._getXmlConfig(url, function(error, config) {
        if (self._isSuccessOrFatal(error))
          return callback(error, config);

        self._getConfigFromAutodiscover(userDetails, callback);
      });
    });
  },

  _getConfigFromDB: function getConfigFromDB(domain, callback) {
    this._getXmlConfig('https://live.mozillamessaging.com/autoconfig/v1.1/' +
                       encodeURIComponent(domain), callback);
  },

  _getMX: function getMX(domain, callback) {
    let xhr = new XMLHttpRequest({mozSystem: true});
    xhr.open('GET', 'https://live.mozillamessaging.com/dns/mx/' +
             encodeURIComponent(domain), true);
    xhr.onload = function() {
      if (xhr.status === 200)
        callback(null, xhr.responseText.split('\n')[0]);
      else
        callback('unknown');
    };
    xhr.onerror = function() { callback('unknown'); };

    xhr.send();
  },

  _getConfigFromMX: function getConfigFromMX(domain, callback) {
    let self = this;
    this._getMX(domain, function(error, mxDomain) {
      if (error)
        return callback(error);

      // XXX: We need to normalize the domain here to get the base domain,
      // but that's complicated because people like putting dots in TLDs.
      if (domain === mxDomain)
        return callback('unknown');

      self._getConfigFromDB(mxDomain, callback);
    });
  },

  getConfig: function getConfig(userDetails, callback) {
    console.log('Attempting to get autoconfiguration...');
    let domain = userDetails.emailAddress.split('@')[1].toLowerCase();

    function callbackWrapper(error) {
      console.log(error ? 'FAILURE' : 'SUCCESS');
      callback.apply(null, arguments);
    }

    console.log('  Looking in GELAM');
    if (autoconfigByDomain.hasOwnProperty(domain)) {
      callbackWrapper(null, autoconfigByDomain[domain]);
      return;
    }

    let self = this;
    console.log('  Looking in local file store');
    this._getConfigFromLocalFile(domain, function(error, config) {
      if (self._isSuccessOrFatal(error))
        return callbackWrapper(error, config);

      console.log('  Looking at domain');
      self._getConfigFromDomain(userDetails, domain, function(error, config) {
        if (self._isSuccessOrFatal(error))
          return callbackWrapper(error, config);

        console.log('  Looking in the Mozilla ISPDB');
        self._getConfigFromDB(domain, function(error, config) {
          if (self._isSuccessOrFatal(error))
            return callbackWrapper(error, config);

          console.log('  Looking up MX');
          self._getConfigFromMX(domain, callbackWrapper);
        });
      });
    });
  },

  tryToCreateAccount: function(universe, userDetails, callback) {
    let self = this;
    this.getConfig(userDetails, function(error, config) {
      if (error)
        return callback(error);

      var configurator = Configurators[config.type];
      configurator.tryToCreateAccount(universe, userDetails, config,
                                      callback, self._LOG);
    });
  },
};

}); // end define
