/**
 * Configurator for imap+smtp and pop3+smtp
 **/

define(
  [
    'rdcommon/log',
    '../accountcommon',
    '../a64',
    '../allback',
    './account',
    '../date',
    'require',
    'exports'
  ],
  function(
    $log,
    $accountcommon,
    $a64,
    $allback,
    $account,
    $date,
    require,
    exports
  ) {

var allbackMaker = $allback.allbackMaker;

exports.account = $account;
exports.configurator = {
  tryToCreateAccount: function(universe, userDetails, domainInfo,
                               callback, _LOG) {
    var credentials, incomingInfo, smtpConnInfo, incomingType;
    if (domainInfo) {
      incomingType = (domainInfo.type === 'imap+smtp' ? 'imap' : 'pop3');
      credentials = {
        username: domainInfo.incoming.username,
        password: userDetails.password,
      };
      incomingInfo = {
        hostname: domainInfo.incoming.hostname,
        port: domainInfo.incoming.port,
        crypto: (typeof domainInfo.incoming.socketType === 'string' ?
                 domainInfo.incoming.socketType.toLowerCase() :
                 domainInfo.incoming.socketType),
      };
      if (incomingType === 'imap') {
        incomingInfo.blacklistedCapabilities = null;
      } else if (incomingType === 'pop3') {
        incomingInfo.preferredAuthMethod = null;
      }
      smtpConnInfo = {
        emailAddress: userDetails.emailAddress, // used for probing
        hostname: domainInfo.outgoing.hostname,
        port: domainInfo.outgoing.port,
        crypto: (typeof domainInfo.outgoing.socketType === 'string' ?
                 domainInfo.outgoing.socketType.toLowerCase() :
                 domainInfo.outgoing.socketType),
      };
    }

    var self = this;
    var callbacks = allbackMaker(
      ['incoming', 'smtp'],
      function probesDone(results) {
        // -- both good?
        if (results.incoming[0] === null && results.smtp[0] === null) {
          var conn = results.incoming[1];
          if (incomingType === 'imap') {
            var imapTZOffset = results.incoming[2];
            var imapBlacklistedCapabilities = results.incoming[3];

            incomingInfo.blacklistedCapabilities = imapBlacklistedCapabilities;

            var account = self._defineImapAccount(
              universe,
              userDetails, credentials,
              incomingInfo, smtpConnInfo, conn,
              imapTZOffset,
              callback);
          } else { // POP3
            incomingInfo.preferredAuthMethod = conn.authMethod;
            var account = self._definePop3Account(
              universe,
              userDetails, credentials,
              incomingInfo, smtpConnInfo, conn,
              callback);
          }
        } else { // -- either/both bad
          if (incomingType === 'imap' || incomingType === 'pop3') {
            // clean up the imap connection if it was okay but smtp failed
            if (results.incoming[0] === null) {
              results.incoming[1].die();
              // Failure was caused by SMTP, but who knows why
              callback(results.smtp[0], null, results.smtp[1]);
            } else {
              callback(results.incoming[0], null, results.incoming[2]);
            }
          }
        }
      });

    require(['../smtp/probe'], function($probe) {
      var smtpProber = new $probe.SmtpProber(credentials, smtpConnInfo, _LOG);
      smtpProber.onresult = callbacks.smtp;
    });
    if (incomingType === 'imap') {
      require(['../imap/probe'], function($probe) {
        var imapProber = new $probe.ImapProber(credentials, incomingInfo, _LOG);
        imapProber.onresult = callbacks.incoming;
      });
    } else {
      require(['../pop3/probe'], function($probe) {
        var pop3Prober = new $probe.Pop3Prober(credentials, incomingInfo, _LOG);
        pop3Prober.onresult = callbacks.incoming;
      });
    }
  },

  recreateAccount: function(universe, oldVersion, oldAccountInfo, callback) {
    var oldAccountDef = oldAccountInfo.def;

    var credentials = {
      username: oldAccountDef.credentials.username,
      password: oldAccountDef.credentials.password,
    };
    var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
    var oldType = oldAccountDef.type || 'imap+smtp';
    var accountDef = {
      id: accountId,
      name: oldAccountDef.name,

      type: oldType,
      receiveType: oldType.split('+')[0],
      sendType: 'smtp',

      syncRange: oldAccountDef.syncRange,
      syncInterval: oldAccountDef.syncInterval || 0,
      notifyOnNew: oldAccountDef.hasOwnProperty('notifyOnNew') ?
                   oldAccountDef.notifyOnNew : true,

      credentials: credentials,
      receiveConnInfo: {
        hostname: oldAccountDef.receiveConnInfo.hostname,
        port: oldAccountDef.receiveConnInfo.port,
        crypto: oldAccountDef.receiveConnInfo.crypto,

        blacklistedCapabilities:
          oldAccountDef.receiveConnInfo.blacklistedCapabilities || null,
        preferredAuthMethod:
          oldAccountDef.receiveConnInfo.preferredAuthMethod || null,
      },
      sendConnInfo: {
        hostname: oldAccountDef.sendConnInfo.hostname,
        port: oldAccountDef.sendConnInfo.port,
        crypto: oldAccountDef.sendConnInfo.crypto,
      },

      identities: $accountcommon.recreateIdentities(universe, accountId,
                                     oldAccountDef.identities),
      // this default timezone here maintains things; but people are going to
      // need to create new accounts at some point...
      tzOffset: oldAccountInfo.tzOffset !== undefined ?
                  oldAccountInfo.tzOffset : -7 * 60 * 60 * 1000,
    };

    this._loadAccount(universe, accountDef,
                      oldAccountInfo.folderInfo, null, function(account) {
      callback(null, account, null);
    });
  },

  /**
   * Define an account now that we have verified the credentials are good and
   * the server meets our minimal functionality standards.  We are also
   * provided with the protocol connection that was used to perform the check
   * so we can immediately put it to work.
   */
  _defineImapAccount: function(universe, userDetails, credentials,
                               incomingInfo, smtpConnInfo, imapProtoConn,
                               tzOffset, callback) {
    var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
    var accountDef = {
      id: accountId,
      name: userDetails.accountName || userDetails.emailAddress,
      defaultPriority: $date.NOW(),

      type: 'imap+smtp',
      receiveType: 'imap',
      sendType: 'smtp',

      syncRange: 'auto',
      syncInterval: userDetails.syncInterval || 0,
      notifyOnNew: userDetails.hasOwnProperty('notifyOnNew') ?
                   userDetails.notifyOnNew : true,

      credentials: credentials,
      receiveConnInfo: incomingInfo,
      sendConnInfo: smtpConnInfo,

      identities: [
        {
          id: accountId + '/' +
                $a64.encodeInt(universe.config.nextIdentityNum++),
          name: userDetails.displayName,
          address: userDetails.emailAddress,
          replyTo: null,
          signature: null
        },
      ],
      tzOffset: tzOffset,
    };

    this._loadAccount(universe, accountDef, null,
                      imapProtoConn, function(account) {
      callback(null, account, null);
    });
  },

  /**
   * Define an account now that we have verified the credentials are good and
   * the server meets our minimal functionality standards.  We are also
   * provided with the protocol connection that was used to perform the check
   * so we can immediately put it to work.
   */
  _definePop3Account: function(universe, userDetails, credentials,
                               incomingInfo, smtpConnInfo, pop3ProtoConn,
                               callback) {
    var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
    var accountDef = {
      id: accountId,
      name: userDetails.accountName || userDetails.emailAddress,
      defaultPriority: $date.NOW(),

      type: 'pop3+smtp',
      receiveType: 'pop3',
      sendType: 'smtp',

      syncRange: 'auto',
      syncInterval: userDetails.syncInterval || 0,
      notifyOnNew: userDetails.hasOwnProperty('notifyOnNew') ?
                   userDetails.notifyOnNew : true,

      credentials: credentials,
      receiveConnInfo: incomingInfo,
      sendConnInfo: smtpConnInfo,

      identities: [
        {
          id: accountId + '/' +
                $a64.encodeInt(universe.config.nextIdentityNum++),
          name: userDetails.displayName,
          address: userDetails.emailAddress,
          replyTo: null,
          signature: null
        },
      ],
    };

    this._loadAccount(universe, accountDef, null,
                      pop3ProtoConn, function(account) {
      callback(null, account, null);
    });
  },

  /**
   * Save the account def and folder info for our new (or recreated) account and
   * then load it.
   */
  _loadAccount: function(universe, accountDef, oldFolderInfo, protoConn,
                         callback) {
    var folderInfo;
    if (accountDef.receiveType === 'imap') {
      folderInfo = {
        $meta: {
          nextFolderNum: 0,
          nextMutationNum: 0,
          lastFolderSyncAt: 0,
          capability: (oldFolderInfo && oldFolderInfo.$meta.capability) ||
            protoConn.capabilities,
          rootDelim: (oldFolderInfo && oldFolderInfo.$meta.rootDelim) ||
            protoConn.delim,
        },
        $mutations: [],
        $mutationState: {},
      };
    } else { // POP3
      folderInfo = {
        $meta: {
          nextFolderNum: 0,
          nextMutationNum: 0,
          lastFolderSyncAt: 0,
        },
        $mutations: [],
        $mutationState: {},
      };
    }
    universe.saveAccountDef(accountDef, folderInfo);
    universe._loadAccount(accountDef, folderInfo, protoConn, callback);
  },
};

}); // end define
