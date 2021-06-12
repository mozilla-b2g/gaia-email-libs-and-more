/**
 * Configurator for imap+smtp and pop3+smtp.
 **/

import { PERFNOW } from 'shared/date';

/**
 * Consuming userDetails and domainInfo, create the account-specific account
 * definition fragments.
 */
export default function(userDetails, domainInfo) {
  let incomingType = (domainInfo.type === 'imap+smtp' ? 'imap' : 'pop3');
  let password = null;
  // If the account has an outgoingPassword, use that; otherwise
  // use the main password. We must take care to treat null values
  // as potentially valid in the future, if we allow password-free
  // account configurations.
  if (userDetails.outgoingPassword !== undefined) {
    password = userDetails.outgoingPassword;
  } else {
    password = userDetails.password;
  }
  let credentials = {
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
      _transientLastRenew: PERFNOW()
    };
  }
  let incomingInfo = {
    hostname: domainInfo.incoming.hostname,
    port: domainInfo.incoming.port,
    crypto: (typeof domainInfo.incoming.socketType === 'string' ?
             domainInfo.incoming.socketType.toLowerCase() :
             domainInfo.incoming.socketType),
  };

  if (incomingType === 'pop3') {
    incomingInfo.preferredAuthMethod = null;
  }
  let smtpConnInfo = {
    emailAddress: userDetails.emailAddress, // used for probing
    hostname: domainInfo.outgoing.hostname,
    port: domainInfo.outgoing.port,
    crypto: (typeof domainInfo.outgoing.socketType === 'string' ?
             domainInfo.outgoing.socketType.toLowerCase() :
             domainInfo.outgoing.socketType),
  };

  return {
    credentials,
    typeFields: {
      receiveType: incomingType,
      sendType: 'smtp'
    },
    connInfoFields: {
      receiveConnInfo: incomingInfo,
      sendConnInfo: smtpConnInfo
    }
  };
}
