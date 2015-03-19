define(function(require) {
'use strict';

var EntireListView = require('./entire_list_view');

function AccountsViewSlice(api, handle, opts) {
  EntireListView.call(this, api, 'accounts', handle);

  this._autoViewFolders = opts && opts.autoViewFolders || false;
}
AccountsViewSlice.prototype = Object.create(EntireListView.prototype);

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

AccountsViewSlice.prototype.eventuallyGetAccountById = function(id) {
  return new Promise(function(resolve, reject) {
    var account = this.getAccountById(id);
    if (account) {
      resolve(account);
      return;
    }
    // If already completed, immediately reject.
    if (this.complete) {
      reject();
      return;
    }

    // Otherwise we're still loading and we'll either find victory in an add or
    // inferred defeat when we get the completion notificaiton.
    var addListener = function(account) {
      if (account.id === id) {
        this.removeListener('add', addListener);
        this.removeListener('complete', completeListener);
        resolve(account);
      }
    }.bind(this);
    var completeListener = function() {
      this.removeListener('add', addListener);
      this.removeListener('complete', completeListener);
      reject();
    }
    this.on('add', addListener);
    this.on('complete', completeListener);
  }.bind(this));
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
