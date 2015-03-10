/**
 * Test slice/splice batching and ordering.
 **/

define(function(require, exports) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $mailapi = require('mailapi');

/**
 * Test that if we send a slice to the backend, it processes them
 * in the correct order
 */
return new LegacyGelamTest('Check Slices In Order', function(T, RT) {
  T.group('setup');
  // Create an empty universe just to create proper slices for us
  var testUniverse = T.actor('TestUniverse', 'U'),
      testAccount = T.actor('TestAccount', 'A', { universe: testUniverse }),
      testContacts = T.actor('TestContacts', 'contacts'),
      eLazy = T.lazyLogger('misc');

  var inboxFolder = testAccount.do_useExistingFolderWithType('inbox', '');
  // Open a slice just for the sake of having a slice; don't care what happens.
  var inboxView = testAccount.do_openFolderView(
    'syncs', inboxFolder, null, null,
    { syncedToDawnOfTime: 'ignore' });

  T.group('test ordering');
  T.action(eLazy, "trap contact lookups, send slice updates, see no updates",
           function() {
    eLazy.expect('pendingLookupCount',  1);
    eLazy.expect('processingMessage',  null);
    // We don't want the slice notifications or the contact resolution to happen
    // this step.  But we do want to make sure that the batching setZeroTimeout
    // has had a chance to fire and that roundtripping of messages has fully
    // occurred.  MailAPI.ping() includes both a zeroTimeout and the
    // roundtripping.
    eLazy.expect('roundtrip');

    var bridgeProxy = testAccount.getSliceBridgeProxyForView(inboxView);
    var sendSplice = bridgeProxy.sendSplice.bind(bridgeProxy);

    // Make calls to mozContacts.find() not return until releaseFindCalls().
    testContacts.trapFindCalls();

    // Ask to resolve a contact.  This will cause pendingLookupCount to hit 1,
    // which will make the splice processing wait until we resolve the contacts.
    testUniverse.MailAPI.resolveEmailAddressToPeep(
      'bob@bob.nul',
      function(peep) {
        eLazy.log('contact resolved!');
      });
    // Do check the lookup count did what we expected and didn't activate other
    // request processing deferral logic.
    eLazy.log('pendingLookupCount',
                     $mailapi.ContactCache.pendingLookupCount);
    eLazy.log('processingMessage',
                     testUniverse.MailAPI._processingMessage);

    inboxView.slice.onsplice = function() {
      eLazy.log('splice!');
    };

    // Send an empty splice, goes in batch 1.
    sendSplice(0, 0, [], 0, false, false);
    // Send another empty splice, also goes in batch 1.
    sendSplice(0, 0, [], 0, false, false);

    testUniverse.MailAPI.ping(function() {
      eLazy.log('roundtrip');
    });
  });

  T.action(eLazy, "resolve contact, see splices", function() {
    var mailapi = testUniverse.MailAPI;

    eLazy.expect('contact resolved!');
    eLazy.expect('splice!');
    eLazy.expect('splice!');

    testContacts.releaseFindCalls();
  });

});

}); // end define

