define(function(require) {
'use strict';

/**
 * XXX XXX THIS IS JUST CODE PULLED OUT OF MAILBRIDGE XXX XXX
 * This all needs to be task-ified, etc.
 */
  var account = this.universe.getAccountForSenderIdentityId(msg.identityId),
      accountDef = account.accountDef,
      identity = this.universe.getIdentityForSenderIdentityId(msg.identityId);

  for (var key in msg.mods) {
    var val = msg.mods[key];

    switch (key) {
      case 'name':
        identity.name = val;
        break;

      case 'address':
        identity.address = val;
        break;

      case 'replyTo':
        identity.replyTo = val;
        break;

      case 'signature':
        identity.signature = val;
        break;

      case 'signatureEnabled':
        identity.signatureEnabled = val;
        break;

      default:
        throw new Error('Invalid key for modifyIdentity: "' + key + '"');
    }
  }
  // accountDef has the identity, so this persists it as well
  this.universe.saveAccountDef(accountDef, null, function() {
    this.__sendMessage({
      type: 'modifyIdentity',
      handle: msg.handle,
    });
  }.bind(this));


});
