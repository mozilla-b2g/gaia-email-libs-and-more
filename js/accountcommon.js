/**
 * Common code for creating and working with various account types.
 *
 * @module
 **/

define(
  [
    './a64',
    'logic',
    './allback',
    'require',
    'module',
    'exports'
  ],
  function(
    $a64,
    logic,
    allback,
    require,
    $module,
    exports
  ) {
'use strict';

var latchedWithRejections = allback.latchedWithRejections;

function requireConfigurator(type, fn) {
  if (type === 'activesync') {
    require(['activesync/configurator'], fn);
  } else if (type === 'pop3+smtp' || type === 'imap+smtp') {
    require(['composite/configurator'], fn);
  }
}

function accountTypeToClass(type, callback) {
  requireConfigurator(type, function(mod) {
    callback(mod.account.Account);
  });
}
exports.accountTypeToClass = accountTypeToClass;

/**
 * Recreate an existing account, e.g. after a database upgrade.
 *
 * @param universe the MailUniverse
 * @param oldVersion the old database version, to help with migration
 * @param accountInfo the old account info
 * @param callback a callback to fire when we've completed recreating the
 *        account
 */
function recreateAccount(universe, oldVersion, accountInfo) {
  return new Promise((resolve, reject) => {
    requireConfigurator(accountInfo.def.type, function (mod) {
      // resolve the promise with the promise returned by the configurator
      resolve(mod.configurator.recreateAccount(universe, oldVersion,
                                               accountInfo));
    });
  });
}
exports.recreateAccount = recreateAccount;

function tryToManuallyCreateAccount(universe, userDetails, domainInfo) {
  return new Promise((resolve, reject) => {
    requireConfigurator(domainInfo.type, function (mod) {
      // resolve the promise with the promise returned by the configurator
      resolve(
        mod.configurator.tryToCreateAccount(universe, userDetails, domainInfo));
    });
  });
}
exports.tryToManuallyCreateAccount = tryToManuallyCreateAccount;

}); // end define
