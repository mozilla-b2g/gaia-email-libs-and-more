/**
 * Account logic that currently needs to be its own file because IndexedDB
 * db reuse makes this test unhappy.
 **/

define(['rdcommon/testcontext', './resources/th_main', './resources/th_contacts',
        'activesync/codepages', 
        'mailapi/mailapi', 
        'exports'],
       function($tc, $th_main, $th_contacts,
        $ascp, 
        $mailapi, 
        exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_splice_ordering' }, null,
  [$th_main.TESTHELPER, $th_contacts.TESTHELPER], ['app']);


/**
 * Test that if we send a slice to the backend, it processes them
 * in the correct order
 */
TD.commonCase('Check Slices In Order', function(T, RT) {
  var pendingUpdates = [];

  // Ideally, I'd like to move this all down to SliceBridgeProxy
  // but couldn't find a clean way to access it
  function sendSlice(index, howMany, addItems, requested,
                                      moreExpected, newEmailCount) {
    var updateSplice = {
      index: index,
      howMany: howMany,
      addItems: addItems,
      requested: requested,
      moreExpected: moreExpected,
      newEmailCount: newEmailCount,
      type: 'slice',
    };
    pendingUpdates.push(updateSplice);
  }

  function updateSlice(mailapi, newStatus, handle, onprocess) {
    var message = {
      type: 'batchSlice',
      handle: handle,
      status: newStatus,
      progress: 0.1,
      atTop: true,
      atBottom: false,
      userCanGrowUpwards: false,
      userCanGrowDownwards: false,
      sliceUpdates: pendingUpdates,
      onprocess: onprocess
    };

    mailapi.__bridgeReceive(message);
    pendingUpdates = [];
  }

  T.group('setup');
  // Create an empty universe just to create proper slices for us
  var testUniverse = T.actor('testUniverse', 'U'),
      testAccount = T.actor('testAccount', 'A', { universe: testUniverse }),
      testContacts = T.actor('testContacts', 'contacts')
      eLazy = T.lazyLogger('misc');

  T.group('sync empty folder');
  var emptyFolder = testAccount.do_createTestFolder(
    'test_empty_sync', { count: 0 });

  // Create a pending contact lookup and make sure we 
  // Don't process any new messages until it's resolved
  var bobsName = 'Bob Bobbington',
  bobsEmail = 'bob@bob.nul';
  T.setup('Create Bob Contact', function() {
    testContacts.createContact(bobsName, [bobsEmail], 'quiet');
  });

  T.action("Test Slice Ordering", eLazy, function() {
    var mailapi = testUniverse.MailAPI;
    var slice = mailapi._slices[1];

    sendSlice(0, 0, [], 0, false, false);
    mailapi.resolveEmailAddressToPeep(bobsEmail, function(peep) {
    });

    updateSlice(mailapi, 'firstStatus', 1, function() {
          eLazy.event('first splice');
        }
    );

    // Send a Second update
    slice = mailapi._slices[1];
    sendSlice(0, 0, [], 0, false, false);
    updateSlice(mailapi, 'updateSplice', 2, function() {
        eLazy.event('update splice');
      }
    );

    // This ordering must be adhered to
    eLazy.expect_event('first splice');
    eLazy.expect_event('update splice');
  });

}); 

}); // end define

