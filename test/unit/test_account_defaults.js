define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');

return new LegacyGelamTest('last created account is default by default',
                           function(T, RT) {
  T.group('setup');
  var initialNonDefaultAccount,
      testUniverse = T.actor('TestUniverse', 'UDefaults'),
      timeValue = Date.now(),
      eLazy = T.lazyLogger('defaultsCreated'),
      testAccount1 = T.actor('TestAccount', 'ADefaults1', {
                       universe: testUniverse,
                       timeWarp: timeValue
                     });

  var testAccount2 = T.actor('TestAccount', 'ADefaults2', {
                       universe: testUniverse,
                       timeWarp: timeValue + 1000,
                       forceCreate: true
                     });

  T.group('initial defaults');

  T.action('second account should be default', eLazy, function() {
    var i,
        acctsSlice = testUniverse.allAccountsSlice,
        defaultId = acctsSlice.defaultAccount.id;

    eLazy.expect('default account id', defaultId);
    eLazy.expect('default account id is not the first account', true);

    eLazy.log('default account id', testAccount2.account.id,
                      testAccount2.account.id);
    eLazy.log('default account id is not the first account',
                      testAccount1.account.id !== defaultId);

    // Find the non-default account and set it to the default. Cycle through
    // slices since the default account may or may not be the first item.
    for (i = 0; i < acctsSlice.items.length; i++) {
      if (acctsSlice.items[i].id !== defaultId) {
        initialNonDefaultAccount = acctsSlice.items[i];
        break;
      }
    }

    eLazy.expect('has a non-default account',  true);
    eLazy.log('has a non-default account', !!initialNonDefaultAccount);
  });

  T.action('change default account', eLazy, function () {
    // Set a value in the cache, to check later to make sure it is
    // cleared when default account is changed
    testUniverse.MailAPI._recvCache.__testAccountDefaults = true;

    eLazy.expect('modifyAccount done');
    eLazy.expect('Default is now first account', initialNonDefaultAccount.id);
    eLazy.expect('Cache is cleared after account modified',  true);

    initialNonDefaultAccount.modifyAccount({ setAsDefault: true }, function() {
      eLazy.log('modifyAccount done');

      var defaultAccount = testUniverse.allAccountsSlice.defaultAccount;
      eLazy.log('Default is now first account',
                        defaultAccount.id,
                        defaultAccount.id);

      eLazy.log('Cache is cleared after account modified',
                      !testUniverse.MailAPI._recvCache
                      .hasOwnProperty('__testAccountDefaults'));
    });
  });

  T.group('shutdown');
  testUniverse.do_saveState();
  testUniverse.do_shutdown();

  T.group('restore');
  var TU2 = T.actor('TestUniverse', 'TU2', {
                        old: testUniverse
                     }),
      TA1 = T.actor('TestAccount', 'ADefaults1', {
                       universe: TU2,
                       restored: true
                     }),
      TA2 = T.actor('TestAccount', 'ADefaults2', {
                       universe: TU2,
                       restored: true
                     }),
      eLazy2 = T.lazyLogger('defaultsRestored');

  T.action('first account should be default', eLazy2, function() {
    var defaultId = TU2.allAccountsSlice.defaultAccount.id;

    eLazy2.expect('default account id is first account', defaultId);
    eLazy2.expect('default account id is not the second account', true);

    eLazy2.log('default account id is first account',
                      TA1.account.id,
                      TA1.account.id);
    eLazy2.log('default account id is not the second account',
                      TA2.account.id !== defaultId);
  });

  T.group('cleanup');
});

}); // end define
