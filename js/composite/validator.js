define(function(require) {
'use strict';

const co = require('co');

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
        engineData: {
          capability: protoConn.capability
        }
      };
    } else {
      engineFields = {
        engine: 'pop3',
        engineData: {
          preferredAuthMethod: protoConn.authMethod
        }
      };
    }
  } catch (error) {
    return {
      error,
      errorDetails: { server: connInfoFields.receiveConnInfo.hostname }
    };
  }

  try {
    // We don't actually care about the return value, just that the probing
    // didn't fail.
    yield sendPromise;
  } catch (error) {
    // If we have an open connection, close it on the way out.
    if (protoConn) {
      protoConn.close();
    }
    return {
      error,
      errorDetails: { server: connInfoFields.sendConnInfo.hostname }
    };
  }

  return {
    engineFields,
    receiveProtoConn: protoConn
  };
});
});
