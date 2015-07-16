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

function checkServerCertificate(url, callback) {
  var match = /^https:\/\/([^:/]+)(?::(\d+))?/.exec(url);
  // probably unit test http case?
  if (!match) {
    callback(null);
    return;
  }
  var port = match[2] ? parseInt(match[2], 10) : 443,
      host = match[1];

  console.log('checking', host, port, 'for security problem');

  var sock = tcpSocket.open(host, port);
  function reportAndClose(err) {
    if (sock) {
      var wasSock = sock;
      sock = null;
      try {
        wasSock.close();
      }
      catch (ex) {
      }
      callback(err);
    }
  }
  // this is a little dumb, but since we don't actually get an event right now
  // that tells us when our secure connection is established, and connect always
  // happens, we write data when we connect to help trigger an error or have us
  // receive data to indicate we successfully connected.
  // so, the deal is that connect is going to happen.
  sock.onopen = function() {
    sock.send(
      new TextEncoder('utf-8').encode('GET /images/logo.png HTTP/1.1\n\n'));
  };
  sock.onerror = function(err) {
    var reportErr = null;
    if (err && typeof(err) === 'object' &&
        /^Security/.test(err.name)) {
      reportErr = 'bad-security';
    }
    reportAndClose(reportErr);
  };
  sock.ondata = function(data) {
    reportAndClose(null);
  };
}

var scope = logic.scope('ActivesyncConfigurator');

exports.account = $asacct;
exports.configurator = {
  timeout: 30 * 1000,
  _getFullDetailsFromAutodiscover: function(userDetails, url) {
    return new Promise((resolve, reject) => {
      logic(scope, 'autodiscover:begin', { url: url });
      $asproto.raw_autodiscover(
        url, userDetails.emailAddress, userDetails.password, self.timeout,
        /* redirects are okay */ false,
        function(error, config) {
          if (error) {
            var failureType = 'no-config-info',
                failureDetails = {};

            if (error instanceof $asproto.HttpError) {
              if (error.status === 401) {
                failureType = 'bad-user-or-pass';
              }
              else if (error.status === 403) {
                failureType = 'not-authorized';
              }
              else {
                failureDetails.status = error.status;
              }
            }
            else if (error instanceof $asproto.AutodiscoverDomainError) {
              logic(scope, 'autodiscover.error', { message: error.message });
            }
            logic(scope, 'autodiscover:end', { url: url, err: failureType });
            resolve({
              error: failureType,
              errorDetails: failureDetails
            });
            return;
          }
          logic(scope, 'autodiscover:end',
                { url: url, server: config.mobileSyncServer.url });

          var autoconfig = {
            type: 'activesync',
            displayName: config.user.name,
            incoming: {
              server: config.mobileSyncServer.url,
              username: config.user.email
            },
          };
          resolve({
            fullConfigInfo: autoconfig
          });
        });
    });
  },

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
  tryToCreateAccount: function(universe, userDetails, domainInfo, callback) {
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
    return new Promise((resolve, reject) => {
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

      conn.connect((error, options) => {
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
                var failureType;
                if (securityError) {
                  failureType = 'bad-security';
                } else {
                  failureType = 'unresponsive-server';
                }
                resolve({
                  error: failureType,
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
    var folderInfo = {
      meta: {
        nextFolderNum: 0,
        nextMutationNum: 0,
        lastFolderSyncAt: 0
      },
      folders: new Map()
    };
    return universe.saveAccountDef(accountDef, folderInfo, protoConn);
  },
};

}); // end define
