/**
 * Configurator for fake
 **/

define(
  [
    'rdcommon/log',
    '../accountcommon',
    '../a64',
    './account',
    'exports'
  ],
  function(
    $log,
    $accountcommon,
    $a64,
    $fakeacct,
    exports
  ) {

exports.account = $fakeacct;
exports.configurator = {
  tryToCreateAccount: function cfg_fake_ttca(universe, userDetails, domainInfo,
                                             callback, _LOG) {
    var credentials = {
      username: userDetails.emailAddress,
      password: userDetails.password,
    };
    var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
    var accountDef = {
      id: accountId,
      name: userDetails.accountName || userDetails.emailAddress,

      type: 'fake',
      syncRange: 'auto',

      credentials: credentials,
      connInfo: {
        hostname: 'magic.example.com',
        port: 1337,
        crypto: true,
      },

      identities: [
        {
          id: accountId + '/' +
                $a64.encodeInt(universe.config.nextIdentityNum++),
          name: userDetails.displayName,
          address: userDetails.emailAddress,
          replyTo: null,
          signature: null
        },
      ]
    };

    this._loadAccount(universe, accountDef, function (account) {
      callback(null, account, null);
    });
  },

  recreateAccount: function cfg_fake_ra(universe, oldVersion, oldAccountInfo,
                                        callback) {
    var oldAccountDef = oldAccountInfo.def;
    var credentials = {
      username: oldAccountDef.credentials.username,
      password: oldAccountDef.credentials.password,
    };
    var accountId = $a64.encodeInt(universe.config.nextAccountNum++);
    var accountDef = {
      id: accountId,
      name: oldAccountDef.name,

      type: 'fake',
      syncRange: oldAccountDef.syncRange,

      credentials: credentials,
      connInfo: {
        hostname: 'magic.example.com',
        port: 1337,
        crypto: true,
      },

      identities: $accountcommon.recreateIdentities(universe, accountId,
                                     oldAccountDef.identities)
    };

    this._loadAccount(universe, accountDef, function (account) {
      callback(null, account, null);
    });
  },

  /**
   * Save the account def and folder info for our new (or recreated) account and
   * then load it.
   */
  _loadAccount: function cfg_fake__loadAccount(universe, accountDef, callback) {
    var folderInfo = {
      $meta: {
        nextMutationNum: 0,
        lastFolderSyncAt: 0,
      },
      $mutations: [],
      $mutationState: {},
    };
    universe.saveAccountDef(accountDef, folderInfo);
    universe._loadAccount(accountDef, folderInfo, null, callback);
  },
};

}); // end define
