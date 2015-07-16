/**
 * Configurator for imap+smtp and pop3+smtp.
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
'use strict';

exports.account = $account;
exports.configurator = {
  tryToCreateAccount: function(universe, userDetails, domainInfo) {
    var credentials, incomingInfo, smtpConnInfo, incomingType;
    if (domainInfo) {
      incomingType = (domainInfo.type === 'imap+smtp' ? 'imap' : 'pop3');
      var password = null;
      // If the account has an outgoingPassword, use that; otherwise
      // use the main password. We must take care to treat null values
      // as potentially valid in the future, if we allow password-free
      // account configurations.
      if (userDetails.outgoingPassword !== undefined) {
        password = userDetails.outgoingPassword;
      } else {
        password = userDetails.password;
      }
      credentials = {
        username: domainInfo.incoming.username,
        password: userDetails.password,
        outgoingUsername: domainInfo.outgoing.username,
        outgoingPassword: password,
      };
      if (domainInfo.oauth2Tokens) {
        // We need to save off all the information so:
        // - the front-end can reauthorize exclusively from this info.
        // - the back-end can refresh its token
        // - on upgrades so we can know if our scope isn't good enough.  (Note
        //   that we're not saving off the secret group; upgrades would need to
        //   factor in the auth or token endpoints.)
        credentials.oauth2 = {
          authEndpoint: domainInfo.oauth2Settings.authEndpoint,
          tokenEndpoint: domainInfo.oauth2Settings.tokenEndpoint,
          scope: domainInfo.oauth2Settings.scope,
          clientId: domainInfo.oauth2Secrets.clientId,
          clientSecret: domainInfo.oauth2Secrets.clientSecret,
          refreshToken: domainInfo.oauth2Tokens.refreshToken,
          accessToken: domainInfo.oauth2Tokens.accessToken,
          expireTimeMS: domainInfo.oauth2Tokens.expireTimeMS,
          // Treat the access token like it was recently retrieved; although we
          // generally expect the XOAUTH2 case should go through without
          // failure, in the event something is wrong, immediately re-fetching
          // a new accessToken is not going to be useful for us.
          _transientLastRenew: $date.PERFNOW()
        };
      }
      incomingInfo = {
        hostname: domainInfo.incoming.hostname,
        port: domainInfo.incoming.port,
        crypto: (typeof domainInfo.incoming.socketType === 'string' ?
                 domainInfo.incoming.socketType.toLowerCase() :
                 domainInfo.incoming.socketType),
      };

      if (incomingType === 'pop3') {
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

    // Note: For OAUTH accounts, the credentials may be updated
    // in-place if a new access token was required. We don't need to
    // explicitly save those changes here because we define the
    // account with the same object below.
    var incomingPromise = new Promise(function(resolve, reject) {
      if (incomingType === 'imap') {
        require(['../imap/probe'], function(probe) {
          probe.probeAccount(credentials, incomingInfo).then(resolve, reject);
        });
      } else {
        require(['../pop3/probe'], function(probe) {
          probe.probeAccount(credentials, incomingInfo).then(resolve, reject);
        });
      }
    });

    var outgoingPromise = new Promise(function(resolve, reject) {
      require(['../smtp/probe'], function(probe) {
        probe.probeAccount(credentials, smtpConnInfo).then(resolve, reject);
      });
    });

    // Note: Promise.all() will fire the catch handler as soon as one
    // of the promises is rejected. While this means we will only see
    // the first error that returns, it actually works well for our
    // semantics, as we only notify the user about one side's problems
    // at a time.
    return Promise.all([incomingPromise, outgoingPromise])
      .then(function(results) {
        var incomingConn = results[0].conn;
        var defineAccount;
        var engine;

        if (incomingType === 'imap') {
          defineAccount = this._defineImapAccount;
          engine = results[0].engine;
        } else if (incomingType === 'pop3') {
          incomingInfo.preferredAuthMethod = incomingConn.authMethod;
          defineAccount = this._definePop3Account;
          engine = 'pop3';
        }
        return defineAccount.call(this, universe, engine,
                                  userDetails, credentials,
                                  incomingInfo, smtpConnInfo, incomingConn);
      }.bind(this))
      .catch(function(ambiguousErr) {
        // One of the account sides failed. Normally we leave the
        // IMAP/POP3 side open for reuse, but if the SMTP
        // configuration falied we must close the incoming connection.
        // (If the incoming side failed as well, we won't receive the
        // `.then` callback.)
        return incomingPromise.then(function incomingOkOutgoingFailed(result) {
          result.conn.close();
          // the error is no longer ambiguous; it was SMTP
          return {
            error: ambiguousErr,
            errorDetails: { server: smtpConnInfo.hostname }
          };
        }).catch(function incomingFailed(incomingErr) {
          return {
            error: incomingErr,
            errorDetails: { server: incomingInfo.hostname }
          };
        });
     });
 },

  recreateAccount: function(universe, oldVersion, oldAccountInfo) {
    var oldAccountDef = oldAccountInfo.def;

    var credentials = {
      username: oldAccountDef.credentials.username,
      password: oldAccountDef.credentials.password,
      // (if these two keys are null, keep them that way:)
      outgoingUsername: oldAccountDef.credentials.outgoingUsername,
      outgoingPassword: oldAccountDef.credentials.outgoingPassword,
      authMechanism: oldAccountDef.credentials.authMechanism,
      oauth2: oldAccountDef.credentials.oauth2
    };
    var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
    var oldType = oldAccountDef.type || 'imap+smtp';
    var accountDef = {
      id: accountId,
      name: oldAccountDef.name,

      type: oldType,
      engine: oldAccountDef.engine || 'vanillaImap',
      receiveType: oldType.split('+')[0],
      sendType: 'smtp',

      syncRange: oldAccountDef.syncRange,
      syncInterval: oldAccountDef.syncInterval || 0,
      notifyOnNew: oldAccountDef.hasOwnProperty('notifyOnNew') ?
                   oldAccountDef.notifyOnNew : true,
      playSoundOnSend: oldAccountDef.hasOwnProperty('playSoundOnSend') ?
                   oldAccountDef.playSoundOnSend : true,

      credentials: credentials,
      receiveConnInfo: {
        hostname: oldAccountDef.receiveConnInfo.hostname,
        port: oldAccountDef.receiveConnInfo.port,
        crypto: oldAccountDef.receiveConnInfo.crypto,
        preferredAuthMethod:
          oldAccountDef.receiveConnInfo.preferredAuthMethod || null,
      },
      sendConnInfo: {
        hostname: oldAccountDef.sendConnInfo.hostname,
        port: oldAccountDef.sendConnInfo.port,
        crypto: oldAccountDef.sendConnInfo.crypto,
      },

      identities: $accountcommon.recreateIdentities(universe, accountId,
                                     oldAccountDef.identities)
    };

    return this._saveAccount(
      universe, accountDef, oldAccountInfo.folderInfo, null);
  },

  /**
   * Define an account now that we have verified the credentials are good and
   * the server meets our minimal functionality standards.  We are also
   * provided with the protocol connection that was used to perform the check
   * so we can immediately put it to work.
   */
  _defineImapAccount: function(universe, engine, userDetails, credentials,
                               incomingInfo, smtpConnInfo, imapProtoConn) {
    var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
    var accountDef = {
      id: accountId,
      name: userDetails.accountName || userDetails.emailAddress,
      defaultPriority: $date.NOW(),

      type: 'imap+smtp',
      engine,
      receiveType: 'imap',
      sendType: 'smtp',

      syncRange: 'auto',
      syncInterval: userDetails.syncInterval || 0,
      notifyOnNew: userDetails.hasOwnProperty('notifyOnNew') ?
                   userDetails.notifyOnNew : true,
      playSoundOnSend: userDetails.hasOwnProperty('playSoundOnSend') ?
                   userDetails.playSoundOnSend : true,

      credentials: credentials,
      receiveConnInfo: incomingInfo,
      sendConnInfo: smtpConnInfo,

      identities: [
        {
          id: accountId + '.' +
                $a64.encodeInt(universe.config.nextIdentityNum++),
          name: userDetails.displayName,
          address: userDetails.emailAddress,
          replyTo: null,
          signature: null,
          signatureEnabled: false
        },
      ]
    };

    return this._saveAccount(universe, accountDef, null, imapProtoConn);
  },

  /**
   * Define an account now that we have verified the credentials are good and
   * the server meets our minimal functionality standards.  We are also
   * provided with the protocol connection that was used to perform the check
   * so we can immediately put it to work.
   */
  _definePop3Account: function(universe, engine, userDetails, credentials,
                               incomingInfo, smtpConnInfo, pop3ProtoConn) {
    var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
    var accountDef = {
      id: accountId,
      name: userDetails.accountName || userDetails.emailAddress,
      defaultPriority: $date.NOW(),

      type: 'pop3+smtp',
      engine,
      receiveType: 'pop3',
      sendType: 'smtp',

      syncRange: 'auto',
      syncInterval: userDetails.syncInterval || 0,
      notifyOnNew: userDetails.hasOwnProperty('notifyOnNew') ?
                   userDetails.notifyOnNew : true,
      playSoundOnSend: userDetails.hasOwnProperty('playSoundOnSend') ?
                   userDetails.playSoundOnSend : true,

      credentials: credentials,
      receiveConnInfo: incomingInfo,
      sendConnInfo: smtpConnInfo,

      identities: [
        {
          id: accountId + '.' +
                $a64.encodeInt(universe.config.nextIdentityNum++),
          name: userDetails.displayName,
          address: userDetails.emailAddress,
          replyTo: null,
          signature: null,
          signatureEnabled: false
        },
      ],
    };

    return this._saveAccount(universe, accountDef, null, pop3ProtoConn);
  },

  /**
   * Save the account def and folder info for our new (or recreated) account and
   * then load it.
   */
  _saveAccount: function(universe, accountDef, oldFolderInfo, protoConn) {
    var folderInfo;
    if (accountDef.receiveType === 'imap') {
      folderInfo = {
        meta: {
          nextFolderNum: 0,
          nextMutationNum: 0,
          lastFolderSyncAt: 0,
          capability: (oldFolderInfo && oldFolderInfo.meta.capability) ||
            protoConn.capability
        },
        folders: new Map()
      };
    } else { // POP3
      folderInfo = {
        meta: {
          nextFolderNum: 0,
          nextMutationNum: 0,
          lastFolderSyncAt: 0,
        },
        folders: new Map()
      };
    }
    return universe.saveAccountDef(accountDef, folderInfo, protoConn);
  },
};

}); // end define
