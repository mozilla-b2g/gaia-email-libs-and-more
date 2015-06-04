define(function(require) {
'use strict';

/**
 * XXX XXX THIS IS JUST CODE PULLED OUT OF MAILBRIDGE XXX XXX
 * THINGS NEED TO BE TASK-IFIED!
 */

var account = this.universe.getAccountForAccountId(msg.accountId),
    accountDef = account.accountDef;

for (var key in msg.mods) {
  var val = msg.mods[key];

  switch (key) {
    case 'name':
      accountDef.name = val;
      break;

    case 'username':
      // See the 'password' section below and/or
      // MailAPI.modifyAccount docs for the rationale for this
      // username equality check:
      if (accountDef.credentials.outgoingUsername ===
          accountDef.credentials.username) {
        accountDef.credentials.outgoingUsername = val;
      }
      accountDef.credentials.username = val;
      break;
    case 'incomingUsername':
      accountDef.credentials.username = val;
      break;
    case 'outgoingUsername':
      accountDef.credentials.outgoingUsername = val;
      break;
    case 'password':
      // 'password' is for changing both passwords, if they
      // currently match. If this account contains an SMTP
      // password (only composite ones will) and the passwords
      // were previously the same, assume that they both need to
      // remain the same. NOTE: By doing this, we save the user
      // from typing their password twice in the extremely common
      // case that both passwords are actually the same. If the
      // SMTP password is actually different, we'll just prompt
      // them for that independently if we discover it's still not
      // correct.
      if (accountDef.credentials.outgoingPassword ===
          accountDef.credentials.password) {
        accountDef.credentials.outgoingPassword = val;
      }
      accountDef.credentials.password = val;
      break;
    case 'incomingPassword':
      accountDef.credentials.password = val;
      break;
    case 'outgoingPassword':
      accountDef.credentials.outgoingPassword = val;
      break;
    case 'oauthTokens':
      var oauth2 = accountDef.credentials.oauth2;
      oauth2.accessToken = val.accessToken;
      oauth2.refreshToken = val.refreshToken;
      oauth2.expireTimeMS = val.expireTimeMS;
      break;

    case 'identities':
      // TODO: support identity mutation
      // we expect a list of identity mutation objects, namely an id and the
      // rest are attributes to change
      break;

    case 'servers':
      // TODO: support server mutation
      // we expect a list of server mutation objects; namely, the type names
      // the server and the rest are attributes to change
      break;

    case 'syncRange':
      accountDef.syncRange = val;
      break;

    case 'syncInterval':
      accountDef.syncInterval = val;
      break;

    case 'notifyOnNew':
      accountDef.notifyOnNew = val;
      break;

    case 'playSoundOnSend':
      accountDef.playSoundOnSend = val;
      break;

    case 'setAsDefault':
      // Weird things can happen if the device's clock goes back in time,
      // but this way, at least the user can change their default if they
      // cycle through their accounts.
      if (val) {
        accountDef.defaultPriority = $date.NOW();
      }
      break;

    default:
      throw new Error('Invalid key for modifyAccount: "' + key + '"');
  }
}

this.universe.saveAccountDef(accountDef, null);

});
