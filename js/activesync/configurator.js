/**
 * Configurator for activesync
 **/

define(function(require) {
'use strict';

const { makeUniqueDeviceId } = require('./account');

/**
 * Consuming userDetails and domainInfo, create the account-specific account
 * definition fragments.
 */
return function(userDetails, domainInfo) {
  let deviceId = makeUniqueDeviceId();

  let credentials;
  let connInfo;
  // If there's an autodiscover endpoint we need to pass that through to the
  // validator stage which will then regenerate the connInfo and the
  // credentials.
  if (domainInfo.incoming.autodiscoverEndpoint) {
    credentials = {
      emailAddress: userDetails.emailAddress,
      password: userDetails.password
    };
    connInfo = {
      autodiscoverEndpoint: domainInfo.incoming.autodiscoverEndpoint,
      deviceId
    };
  } else {
    credentials = {
      username: domainInfo.incoming.username,
      password: userDetails.password
    };
    connInfo = {
      server: domainInfo.incoming.server,
      deviceId
    };
  }

  return {
    credentials,
    typeFields: {
    },
    connInfoFields: {
      connInfo
    }
  };
};
}); // end define
