/**
 * Configurator for imap+smtp
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
  tryToCreateAccount: function cfg_is_ttca(universe, userDetails, domainInfo,
                                           callback, _LOG) {
    var credentials, imapConnInfo, smtpConnInfo;
    if (domainInfo) {
      credentials = {
        username: domainInfo.incoming.username,
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
        if (results.imap[0] === null && results.smtp[0] === null) {
          var account = self._defineImapAccount(
            universe,
            userDetails, credentials,
            imapConnInfo, smtpConnInfo, results.imap[1],
            results.imap[2],
            callback);
        }
        // -- either/both bad
        else {
          // clean up the imap connection if it was okay but smtp failed
          if (results.imap[0] === null) {
            results.imap[1].die();
            // Failure was caused by SMTP, but who knows why
            callback(results.smtp[0], null, results.smtp[1]);
          } else {
            callback(results.imap[0], null, results.imap[2]);
          }
          return;
        }
      });

    require(['../imap/probe', '../smtp/probe',], function ($imapprobe, $smtpprobe) {

      var imapProber = new $imapprobe.ImapProber(credentials, imapConnInfo,
                                                 _LOG);
      imapProber.onresult = callbacks.imap;

      var smtpProber = new $smtpprobe.SmtpProber(credentials, smtpConnInfo,
                                                 _LOG);
      smtpProber.onresult = callbacks.smtp;
    });
  },

  recreateAccount: function cfg_is_ra(universe, oldVersion, oldAccountInfo,
                                      callback) {
    var oldAccountDef = oldAccountInfo.def;

    var credentials = {
      username: oldAccountDef.credentials.username,
      password: oldAccountDef.credentials.password,
    };
    var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
    var accountDef = {
      id: accountId,
      name: oldAccountDef.name,

      type: 'imap+smtp',
      receiveType: 'imap',
      sendType: 'smtp',

      syncRange: oldAccountDef.syncRange,

      credentials: credentials,
      receiveConnInfo: {
        hostname: oldAccountDef.receiveConnInfo.hostname,
        port: oldAccountDef.receiveConnInfo.port,
        crypto: oldAccountDef.receiveConnInfo.crypto,
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
                      oldAccountInfo.folderInfo, null, function (account) {
      callback(null, account, null);
    });
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
                        imapProtoConn, tzOffset, callback) {
    var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
    var accountDef = {
      id: accountId,
      name: userDetails.accountName || userDetails.emailAddress,
      defaultPriority: $date.NOW(),

      type: 'imap+smtp',
      receiveType: 'imap',
      sendType: 'smtp',

      syncRange: 'auto',

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
          signature: null
        },
      ],
      tzOffset: tzOffset,
    };

    this._loadAccount(universe, accountDef, null,
                      imapProtoConn, function (account) {
      callback(null, account, null);
    });
  },

  /**
   * Save the account def and folder info for our new (or recreated) account and
   * then load it.
   */
  _loadAccount: function cfg_is__loadAccount(universe, accountDef,
                                             oldFolderInfo, imapProtoConn,
                                             callback) {
    // XXX: Just reload the old folders when applicable instead of syncing the
    // folder list again, which is slow.
    var folderInfo = {
      $meta: {
        nextFolderNum: 0,
        nextMutationNum: 0,
        lastFolderSyncAt: 0,
        capability: (oldFolderInfo && oldFolderInfo.$meta.capability) ||
                    imapProtoConn.capabilities,
        rootDelim: (oldFolderInfo && oldFolderInfo.$meta.rootDelim) ||
                   imapProtoConn.delim,
      },
      $mutations: [],
      $mutationState: {},
    };
    universe.saveAccountDef(accountDef, folderInfo);
    universe._loadAccount(accountDef, folderInfo, imapProtoConn, callback);
  },
};

}); // end define
