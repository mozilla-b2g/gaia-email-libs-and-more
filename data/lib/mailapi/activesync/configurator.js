/**
 * Configurator for activesync
 **/

define(
  [
    'rdcommon/log',
    '../accountcommon',
    '../a64',
    './account',
    'exports'
  ],
  function(
    $log,
    $accountcommon,
    $a64,
    $asacct,
    exports
  ) {

exports.account = $asacct;
exports.configurator = {
  tryToCreateAccount: function cfg_as_ttca(universe, userDetails, domainInfo,
                                           callback, _LOG) {
    require(['activesync/protocol'], function ($asproto) {
      var credentials = {
        username: domainInfo.incoming.username,
        password: userDetails.password,
      };

      var self = this;
      var conn = new $asproto.Connection();
      conn.open(domainInfo.incoming.server, credentials.username,
                credentials.password);
      conn.timeout = $asacct.DEFAULT_TIMEOUT_MS;

      conn.connect(function(error, options) {
        if (error) {
          // This error is basically an indication of whether we were able to
          // call getOptions or not.  If the XHR request completed, we get an
          // HttpError.  If we timed out or an XHR error occurred, we get a
          // general Error.
          var failureType,
              failureDetails = { server: domainInfo.incoming.server };

          if (error instanceof $asproto.HttpError) {
            if (error.status === 401) {
              failureType = 'bad-user-or-pass';
            }
            else if (error.status === 403) {
              failureType = 'not-authorized';
            }
            // Treat any other errors where we talked to the server as a problem
            // with the server.
            else {
              failureType = 'server-problem';
              failureDetails.status = error.status;
            }
          }
          else {
            // We didn't talk to the server, so let's call it an unresponsive
            // server.
            failureType = 'unresponsive-server';
          }
          callback(failureType, null, failureDetails);
          return;
        }

        var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
        var accountDef = {
          id: accountId,
          name: userDetails.accountName || userDetails.emailAddress,

          type: 'activesync',
          syncRange: 'auto',

          credentials: credentials,
          connInfo: {
            server: domainInfo.incoming.server
          },

          identities: [
            {
              id: accountId + '/' +
                  $a64.encodeInt(universe.config.nextIdentityNum++),
              name: userDetails.displayName || domainInfo.displayName,
              address: userDetails.emailAddress,
              replyTo: null,
              signature: null
            },
          ]
        };

        self._loadAccount(universe, accountDef, conn, function (account) {
          callback(null, account, null);
        });
      });
    }.bind(this));
  },

  recreateAccount: function cfg_as_ra(universe, oldVersion, oldAccountInfo,
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

      type: 'activesync',
      syncRange: oldAccountDef.syncRange,

      credentials: credentials,
      connInfo: {
        server: oldAccountDef.connInfo.server
      },

      identities: $accountcommon.recreateIdentities(universe, accountId,
                                     oldAccountDef.identities)
    };

    this._loadAccount(universe, accountDef, null, function (account) {
      callback(null, account, null);
    });
  },

  /**
   * Save the account def and folder info for our new (or recreated) account and
   * then load it.
   */
  _loadAccount: function cfg_as__loadAccount(universe, accountDef,
                                             protoConn, callback) {
    // XXX: Just reload the old folders when applicable instead of syncing the
    // folder list again, which is slow.
    var folderInfo = {
      $meta: {
        nextFolderNum: 0,
        nextMutationNum: 0,
        lastFolderSyncAt: 0,
        syncKey: '0',
      },
      $mutations: [],
      $mutationState: {},
    };
    universe.saveAccountDef(accountDef, folderInfo);
    universe._loadAccount(accountDef, folderInfo, protoConn, callback);
  },
};

}); // end define