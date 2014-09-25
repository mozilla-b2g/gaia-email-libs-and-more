/**
 * Make sure that if POP3 receives a message without a Date header that we
 * don't freak out and explode but instead arbitrarily use the current date.
 * (See the actual implementation for our rationale on that.  Which is top
 * notch hand-waving, I assure you.)
 **/

define(function(require, exports) {

var $tc = require('rdcommon/testcontext');
var $th_main = require('./resources/th_main');
var $date = require('date');

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_pop3_no_date' }, null,
  [$th_main.TESTHELPER], ['app']);

TD.commonCase('do not die on messages with no date', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('testUniverse', 'U');
  var testAccount = T.actor('testAccount', 'A', { universe: testUniverse });
  var eSync = T.lazyLogger('sync');

  var inboxFolder = testAccount.do_useExistingFolderWithType('inbox', '');

  testAccount.do_addMessagesToFolder(inboxFolder,
    // Do not generate a date header!
    { count: 1, clobberHeaders: { Date: null } });

  T.group('sync the message without a date without dying');
  var inboxView = testAccount.do_openFolderView(
    'inboxView', inboxFolder,
    { count: 1, full: 1, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  T.group('that message better claim to have just been received');
  T.check(eSync, 'date should be now', function() {
    var datelessMessage = inboxView.slice.items[0];
    // note that by default all tests use a latched 'NOW'
    eSync.expect_namedValue('message date', $date.NOW());
    eSync.namedValue('message date', datelessMessage.date.valueOf());
  });

  T.group('cleanup');
});

}); // end define
