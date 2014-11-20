/**
 * net-c.com/netc.fr doesn't provide a timezone with its INTERNALDATE value in
 * response to FETCH requests.  Verify that we handle this without dying,
 * treating no timezone as equivalent to +0000.
 **/

define(function(require, exports) {

var $tc = require('rdcommon/testcontext');
var $th_main = require('./resources/th_main');
var slog = require('slog');

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_internaldate_no_tz' }, null,
  [$th_main.TESTHELPER], ['app']);

TD.commonCase('basic sync succeeds', function(T, RT) {
  T.group('setup');

  var testUniverse = T.actor('testUniverse', 'U');
  var testAccount = T.actor(
    'testAccount', 'A',
    {
      universe: testUniverse,
      imapExtensions: ['NO_INTERNALDATE_TZ']
    });

  T.group('sync');
  var saturatedFolder = testAccount.do_createTestFolder(
    'test_internaldate_no_tz',
    { count: 5, age: { days: 1 }, age_incr: { days: 1 }, age_incr_every: 1 });
  testAccount.do_viewFolder(
    'syncs', saturatedFolder,
    { count: 5, full: 5, flags: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  T.group('cleanup');
});

});
