/**
 * Configurator for activesync
 **/

define(
  [
    'logic',
    '../accountcommon',
    '../a64',
    './account',
    '../date',
    'tcp-socket',
    'activesync/protocol',
    'require',
    'exports'
  ],
  function(
    logic,
    $accountcommon,
    $a64,
    $asacct,
    $date,
    tcpSocket,
    $asproto,
    require,
    exports
  ) {
'use strict';



exports.configurator = {
  /**
   * There are 2 scenarios we can get invoked with:
   * - Direct creation.  We already know the ActiveSync endpoint.  This happens
   *   from a hardcoded (for testing) or local (hotmail.com/outlook.com)
   *   autoconfig entry OR from a user typing that stuff in manually.
   *
   * - Indirection creation.  We just know an AutoDiscover endpoing and need
   *   to run AutoDiscover.  If our autoconfig process probed and found some
   *   AutoDiscover looking endpoints, that's how we end up here.  It's also
   *   conceivable that in the future the manual config mode could use this
   *   path.
   */
  tryToCreateAccount: function(universe, userDetails, domainInfo) {
    if (domainInfo.incoming.autodiscoverEndpoint) {
      return this._getFullDetailsFromAutodiscover(
        userDetails, domainInfo.incoming.autodiscoverEndpoint)
      .then((results) => {
        // If we got an error, pass it directly back.
        if (results.error) {
          return results;
        }
        // Otherwise we have a config and should continue the creation
        // process.
        return this._createAccountUsingFullInfo(
          universe, userDetails, results.fullConfigInfo);
      });
    }
    // We should have full config info then.  Just call direct in.
    return this._createAccountUsingFullInfo(universe, userDetails, domainInfo);
  },

  _createAccountUsingFullInfo: function(universe, userDetails, domainInfo) {
    return new Promise((resolve) => {
      logic(scope, 'create:begin', { server: domainInfo.incoming.server });
      var credentials = {
        username: domainInfo.incoming.username,
        password: userDetails.password,
      };

      var deviceId = $asacct.makeUniqueDeviceId();

      var conn = new $asproto.Connection(deviceId);
      conn.open(domainInfo.incoming.server, credentials.username,
                credentials.password);
      conn.timeout = $asacct.DEFAULT_TIMEOUT_MS;

      conn.connect((error/*, options*/) => {
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
            // We didn't talk to the server, so it's either an unresponsive
            // server or a server with a bad certificate.  (We require https
            // outside of unit tests so there's no need to branch here.)
            checkServerCertificate(
              domainInfo.incoming.server,
              function(securityError) {
                resolve({
                  error: securityError ? 'bad-security' : 'unresponsive-server',
                  errorDetails: failureDetails
                });
              });
            return;
          }
          logic(scope, 'create:end', {
            server: domainInfo.incoming.server,
            err: failureType
          });

          resolve({
            error: failureType,
            errorDetails: failureDetails
          });
          return;
        }

        var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
        var accountDef = {
          id: accountId,
          name: userDetails.accountName || userDetails.emailAddress,
          defaultPriority: $date.NOW(),

          type: 'activesync',
          engine: 'activesync',
          engineData: {},
          syncRange: 'auto',

          syncInterval: userDetails.syncInterval || 0,
          notifyOnNew: userDetails.hasOwnProperty('notifyOnNew') ?
                       userDetails.notifyOnNew : true,
          playSoundOnSend: userDetails.hasOwnProperty('playSoundOnSend') ?
                       userDetails.playSoundOnSend : true,

          credentials: credentials,
          connInfo: {
            server: domainInfo.incoming.server,
            deviceId: deviceId
          },

          identities: [
            {
              id: accountId + '.' +
                  $a64.encodeInt(universe.config.nextIdentityNum++),
              name: userDetails.displayName || domainInfo.displayName,
              address: userDetails.emailAddress,
              replyTo: null,
              signature: null
            },
          ]
        };

        logic(scope, 'create:end', {
          server: domainInfo.incoming.server,
          id: accountId
        });

        resolve(this._saveAccount(universe, accountDef, conn));
      });
    });
  },

  recreateAccount: function(universe, oldVersion, oldAccountInfo) {
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
      engine: 'activesync',
      engineData: oldAccountInfo.engineData,
      syncRange: oldAccountDef.syncRange,
      syncInterval: oldAccountDef.syncInterval || 0,
      notifyOnNew: oldAccountDef.hasOwnProperty('notifyOnNew') ?
                   oldAccountDef.notifyOnNew : true,
      playSoundOnSend: oldAccountDef.hasOwnProperty('playSoundOnSend') ?
                   oldAccountDef.playSoundOnSend : true,

      credentials: credentials,
      connInfo: {
        server: oldAccountDef.connInfo.server,
        deviceId: oldAccountDef.connInfo.deviceId ||
                  $asacct.makeUniqueDeviceId()
      },

      identities: $accountcommon.recreateIdentities(universe, accountId,
                                     oldAccountDef.identities)
    };

    return this._saveAccount(universe, accountDef, null);
  },

  /**
   * Save the account def and folder info for our new (or recreated) account and
   * then load it.
   */
  _saveAccount: function cfg_as__saveAccount(universe, accountDef, protoConn) {
    return universe.saveAccountDef(accountDef, protoConn);
  },
};
}); // end define
