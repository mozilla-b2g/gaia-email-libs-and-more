/**
 * Test the timezone prober logic that needs fakeserver support.  Currently
 * this just means a server that does not tell us UIDNEXT.
 **/

define(function(require, exports) {

var $tc = require('rdcommon/testcontext');
var $th_main = require('./resources/th_main');
var slog = require('slog');

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_incoming_imap_tz_prober' }, null,
  [$th_main.TESTHELPER], ['app']);

/**
 * Some servers, for example coremail (used by 163.com and 126.com) may not
 * report UIDNEXT when SELECTing or EXAMINEing a folder.  It's important that
 * we are still able to establish an account with this.
 */
TD.commonCase('lack of UIDNEXT on TZ prober', function(T, RT) {
  T.group('setup');
  var lc = new slog.LogChecker(T, RT, 'tzprobe');

  // To help test the logic force the decision of a timezone that is both not
  // our own and not the default.  For simplicity we set the default to our
  // own timezone.
  // NOTE NOTE NOTE
  // getTimezoneOffset has the opposite sign from the millisecond-based tz
  // offset used by gelam.  For example, for GMT-5 (aka -0500),
  // getTimezoneOffset will return -300 = -(5 * 60).  So when converting these
  // values into milliseconds, we also must flip the sign!
  var ourTimezoneMins = (new Date()).getTimezoneOffset();
  var useTimezoneMins = ourTimezoneMins + 60;

  var testUniverse = T.actor('testUniverse', 'U');
  // (This must be called prior to the account being defined since its
  // setup depends on this value.)
  testUniverse.do_adjustSyncValues({
    // this offset is specified in milliseconds, see above for sign flip.
    DEFAULT_TZ_OFFSET: -useTimezoneMins * 60 * 1000
  });


  var testAccount = T.actor(
    'testAccount', 'A',
    {
      universe: testUniverse,
      imapExtensions: ['NOUIDNEXT'],
      useTimezoneMins: useTimezoneMins,
      expectDuringCreate: function() {
        // note that the sign flip is intentional, see above.
        lc.mustLog('probe:imap:timezone',
                   { how: 'seq', tzMillis: -useTimezoneMins * 60 * 1000 });
      }
    });

  T.group('that was the test');
  T.check('seriously, if we got this far, we passed', function() {
    console.log('yeah! high five!');
  });

  T.group('cleanup');
});

});
