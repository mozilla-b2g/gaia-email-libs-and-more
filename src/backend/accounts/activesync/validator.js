import logic from 'logic';

import probe from './probe';

import { AUTOCONFIG_TIMEOUT_MS } from '../../syncbase';

import { raw_autodiscover, HttpError, AutodiscoverDomainError }
  from 'activesync/protocol';

const scope = logic.scope('ActivesyncConfigurator');

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
          logic(scope, 'autodiscover:end', { url: url, error: failureType });
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
 * A combination of validation and filling in autodiscover blanks.
 *
 * There are 2 scenarios we can get invoked with:
 * - Direct creation.  We already know the ActiveSync endpoint.  This happens
 *   from a hardcoded (for testing) or local (hotmail.com/outlook.com)
 *   autoconfig entry OR from a user typing that stuff in manually.
 *
 * - Indirection creation.  We just know an AutoDiscover endpoint and need
 *   to run AutoDiscover.  If our autoconfig process probed and found some
 *   AutoDiscover looking endpoints, that's how we end up here.  It's also
 *   conceivable that in the future the manual config mode could use this
 *   path.
 *
 * In the indirect path we will run autodiscover and mutate connInfoFields.
 * Alternately, we could arguably have done this during the configurator stage,
 * but we're currently trying to keep the configurator stage offline-only with
 * the validator as the spot the online stuff happens.
 */
export default async function(fragments) {
  let { credentials, connInfoFields } = fragments;
  // - Need to run an autodiscover?
  if (connInfoFields.connInfo.autodiscoverEndpoint) {
    let { error, errorDetails, fullConfigInfo } =
      await getFullDetailsFromAutodiscover(
        credentials, connInfoFields.connInfo.autodiscoverEndpoint);

    if (error) {
      return { error, errorDetails };
    }

    fragments.credentials = credentials = {
      username: fullConfigInfo.incoming.username,
      password: credentials.password
    };
    connInfoFields.connInfo = {
      server: fullConfigInfo.incoming.server,
      deviceId: connInfoFields.connInfo.deviceId
    };
  }
  // (now it's as if we were a fully specified direct creation)

  // - Run the probe!
  let { conn, error, errorDetails } = await probe({
     connInfo: connInfoFields.connInfo,
     credentials
  });

  if (error) {
    return { error, errorDetails };
  }

  return {
    engineFields: {
      engine: 'activesync',
      engineData: {}
    },
    receiveProtoConn: conn
  };
}
