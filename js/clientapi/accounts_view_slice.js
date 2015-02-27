define(function(require) {
'use strict';

var BridgedViewSlice = require('./bridged_view_slice');

function AccountsViewSlice(api, handle) {
  BridgedViewSlice.call(this, api, 'accounts', handle);
}
AccountsViewSlice.prototype = Object.create(BridgedViewSlice.prototype);

/**
 * Return the account with the given ID, or null.
 */
AccountsViewSlice.prototype.getAccountById = function(id) {
  for (var i = 0; i < this.items.length; i++) {
    if (this.items[i]._wireRep.id === id) {
      return this.items[i];
    }
  }
  return null;
};

Object.defineProperty(AccountsViewSlice.prototype, 'defaultAccount', {
  get: function () {
    var defaultAccount = this.items[0];
    for (var i = 1; i < this.items.length; i++) {
      // For UI upgrades, the defaultPriority may not be set, so default to
      // zero for comparisons
      if ((this.items[i]._wireRep.defaultPriority || 0) >
          (defaultAccount._wireRep.defaultPriority || 0))
        defaultAccount = this.items[i];
    }

    return defaultAccount;
  }
});

return AccountsViewSlice;
});
