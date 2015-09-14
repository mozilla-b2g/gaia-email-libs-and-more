define(function(require) {
'use strict';

const co = require('co');
const logic = require('logic');
const tcpSocket = require('tcp-socket');

const { AUTOCONFIG_TIMEOUT_MS } = require('../syncbase');

const { raw_autodiscover, HttpError, AutodiscoverDomainError } =
  require('activesync/protocol');

const scope = logic.scope('ActivesyncConfigurator');


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
        // nothing to do
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
  sock.ondata = function(/*data*/) {
    reportAndClose(null);
  };
}

function getFullDetailsFromAutodiscover(userDetails, url) {
  return new Promise((resolve) => {
    logic(scope, 'autodiscover:begin', { url });
    raw_autodiscover(
      url, userDetails.emailAddress, userDetails.password,
      AUTOCONFIG_TIMEOUT_MS,
      /* redirects are okay */ false,
      function(error, config) {
        if (error) {
          var failureType = 'no-config-info',
              failureDetails = {};

          if (error instanceof HttpError) {
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
          else if (error instanceof AutodiscoverDomainError) {
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
              { url, server: config.mobileSyncServer.url });

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
}


/**
 * Validate the credentials and connection configurations for the given account.
 * This is currently used for account creation, but could also be used for
 * validating potentially more serious changes to an account, should we allow
 * more of the configuration to be changed than just the password.
 *
 * Note that the credentials may be mutated in the case of oauth2, so this is
 * not some pure functional routine.
 *
 * Returns { engineFields, receiveProtoConn } on success, { error,
 * errorDetails } on failure.
 */
return co.wrap(function*({ credentials, typeFields, connInfoFields }) {
  let isImap = (typeFields.receiveType === 'imap');

  // - Dynamically load the required modules.
  let receiveProbeId =  isImap ? '../imap/probe' : '../pop3/probe';

  let [receiveProber, sendProber] = yield new Promise((resolve) => {
    require(
      [receiveProbeId, '../smtp/probe'],
      (receiveMod, sendMod) => {
        resolve([receiveMod, sendMod]);
      });
  });

  // - Initiate the probes in parallel...
  // Note: For OAUTH accounts, the credentials may be updated
  // in-place if a new access token was required.  Our callers are required to
  // be cool with this.
  let receivePromise =
    receiveProber.probeAccount(credentials, connInfoFields.receiveConnInfo);
  let sendPromise =
    sendProber.probeAccount(credentials, connInfoFields.sendConnInfo);
  // ... but we don't have to process them in that order.

  // - Process the receive probe results
  let engineFields;
  let protoConn;
  // (the prober will throw any failure result)
  try {
    let receiveResults = yield receivePromise;

    protoConn = receiveResults.conn;
    if (isImap) {
      engineFields = {
        engine: receiveResults.engine,
        engineDetails: {
          capability: protoConn.capability
        }
      };
    } else {
      engineFields = {
        engine: 'pop3',
        engineDetails: {
          preferredAuthMethod: protoConn.authMethod
        }
      };
    }
  } catch (err) {
    return {
      error: err,
      errorDetails: { server: connInfoFields.receiveConnInfo.hostname }
    };
  }

  try {
    // We don't actually care about the return value, just that the probing
    // didn't fail.
    yield sendPromise;
  } catch (err) {
    // If we have an open connection, close it on the way out.
    if (protoConn) {
      protoConn.close();
    }
    return {
      error: err,
      errorDetails: { server: connInfoFields.sendConnInfo.hostname }
    };
  }

  return {
    engineFields,
    receiveProtoConn: protoConn
  };
});
});
