/**
 * Test the checkServerProblems logic in mailapi/imap/probe.js
 *
 * This includes simulating both broken servers and working servers.  We want
 * to make sure out broken-server detecting logic does not foul up on a server
 * that correctly implements an extension, etc.
 */

define(['rdcommon/testcontext', './resources/th_main',
        './resources/messageGenerator', 'exports'],
       function($tc, $th_imap, $msggen, exports) {

var TD = exports.TD = $tc.defineTestsFor(
  { id: 'test_imap_bad_servers' }, null, [$th_imap.TESTHELPER], ['app']);

/**
 * Create a server with a broken SPECIAL-USE implementation that does not
 * report the INBOX so that we black-list its implementation.
 *
 * The account should still create successfully, it's just that it will have
 * the capability blacklisted.
 *
 * We declare victory if:
 * - The capability is explicitly blacklisted in the account info.
 * - We have an Inbox and a 'Custom' folder.  The Inbox tells us syncFolderList
 *   did not take away our Inbox (we did that before the fix), and 'Custom'
 *   tells us that we actually used the non-special-use folder list command.
 *   (We require using a fake IMAP server, and our fake IMAP server by default
 *   creates a 'Custom' folder account for purposes such as this.)
 */
TD.commonCase('blacklist broken SPECIAL-USE implementation', function(T, RT) {
  T.group('setup');
  var testUniverse =
        T.actor('testUniverse', 'U'),
      testAccount =
        T.actor('testAccount', 'A',
                {
                  universe: testUniverse,
                  imapExtensions: ['RFC2195', 'bad_special_use']
                }),
      eCheck = T.lazyLogger('check');

  T.group('check');

  T.check(eCheck, 'SPECIAL-USE is blacklisted', function() {
    eCheck.expect_namedValue('blacklist', ['SPECIAL-USE']);
    eCheck.namedValue(
      'blacklist',
      testAccount.imapAccount._connInfo.blacklistedCapabilities);
  });

  T.check(eCheck, 'Has Inbox and Custom folders', function() {
    eCheck.expect_namedValue('has Inbox', true);
    eCheck.expect_namedValue('has Custom', true);

    eCheck.namedValue(
      'has Inbox',
      !!testUniverse.allFoldersSlice.getFirstFolderWithType('inbox'));
    eCheck.namedValue(
      'has Custom',
      !!testUniverse.allFoldersSlice.getFirstFolderWithName('Custom'));
  });

  T.group('cleanup');
  // Yuck.  So, this is an example where the next test case does not need our
  // leftover account and it's simpler to understand without it.  We would
  // ideally not have our account carry into the next test case anyways, but
  // we have to manually do this for now.  We could put the next case in its
  // own file, but these cases are fairly related.
  // TODO: not have to manually clean this up.
  testAccount.do_deleteAccount('cleanup');
});

/**
 * Create a server with a working SPECIAL-USE implementation.  Make sure we
 * don't accidentally blacklist it.
 *
 * We verify that special-use is working at all by having the server
 * identify the type of the 'custom' folder as "archive", which is not
 * something our naming heuristic would ever do.
 */
TD.commonCase('use working SPECIAL-USE implementation', function(T, RT) {
  T.group('setup');
  var testUniverse =
        T.actor('testUniverse', 'U', { restored: true }),
      testAccount =
        T.actor('testAccount', 'B',
                {
                  universe: testUniverse,
                  // 6154 is SPECIAL-USE
                  imapExtensions: ['RFC2195', 'RFC6154']
                }),
      eCheck = T.lazyLogger('check');

  T.group('check');

  T.check(eCheck, 'nothing is blacklisted', function() {
    eCheck.expect_namedValue('blacklist', null);
    eCheck.namedValue(
      'blacklist',
      testAccount.imapAccount._connInfo.blacklistedCapabilities);
  });

  T.check(eCheck, 'Has Inbox and Custom folders', function() {
    eCheck.expect_namedValue('has Inbox', true);
    eCheck.expect_namedValue('has Custom', true);
    eCheck.expect_namedValue('Custom folder type', 'archive');

    eCheck.namedValue(
      'has Inbox',
      !!testUniverse.allFoldersSlice.getFirstFolderWithType('inbox'));
    var customFolder =
          testUniverse.allFoldersSlice.getFirstFolderWithName('Custom');
    eCheck.namedValue('has Custom', !!customFolder);
    eCheck.namedValue('Custom folder type', customFolder.type);
  });

  T.group('cleanup');
});

}); // end define
