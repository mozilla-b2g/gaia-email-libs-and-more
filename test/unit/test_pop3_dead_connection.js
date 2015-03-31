/**
 * Test that a dead connection terminates the POP3 sync process; this is
 * intended to cover the situation where disaster recovery is the one that
 * decides to terminate the connection.
 *
 * In the process of creating/fixing test_pop3_no_date.js it was observed that
 * disaster recovery was triggering during the POP3 sync process when we threw
 * an exception parsing the message without a date but that sync was not
 * properly cleaning up after itself.
 *
 * This was happening because listMessages did not directly listen for
 * connection loss itself but instead depended on the individual requests
 * tracked by Pop3Protocol to generate errors when the connection closed.  In
 * this specific error case, the exception was being generated as a result of
 * the last request known to Pop3Protocol and Pop3Protocol had already shifted
 * the request out to invoke its callback.
 **/

define(function(require) {

var LegacyGelamTest = require('./resources/legacy_gelamtest');
var $fawlty = require('./resources/fault_injecting_socket');
var $pop3 = require('pop3/pop3');
var FawltySocketFactory = $fawlty.FawltySocketFactory;

return new LegacyGelamTest('various dead connections', function(T, RT) {
  T.group('setup');
  var testUniverse = T.actor('TestUniverse', 'U');
  var testAccount = T.actor('TestAccount', 'A', { universe: testUniverse });
  var eSync = T.lazyLogger('sync');

  var inboxFolder = testAccount.do_useExistingFolderWithType('inbox', '');

  // Perform an initial sync just so we can have top/bottom be true.
  testAccount.do_viewFolder(
    'initial sync', inboxFolder,
    { count: 0, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: null },
    { syncedToDawnOfTime: true });

  testAccount.do_addMessagesToFolder(inboxFolder, { count: 1 });

  // - Die during listMessages/UIDL.
  // This will result in the protocol's onclose notification firing first and
  // killing us since listMessages left an entry in `pendingRequests` that had
  // not yet been serviced.
  T.group('connection dies during UIDL');
  testAccount.do_viewFolder(
    'syncs', inboxFolder,
    { count: 0, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: 0 },
    {
      failure: 'deadconn', nosave: true,
      expectFunc: function() {
        FawltySocketFactory.precommand(
          testAccount.pop3Host, testAccount.pop3Port,
          { cmd: 'close-on-send', match: /UIDL/ });
      }
    });

  // - Die while fetching the envelope info / snippet using TOP.
  // Like the UIDL case, this will still result in a pendingRequests-based
  // death.  Except in this case downloadPartialMessageByNumber returns with
  // an error which resulted in crashes previously.
  //
  // Note that some internal stuff may say we learned about the 1 message, but
  // since we never make it to the storeMessage call, it doesn't count and this
  // is still a zero-sync.
  T.group('connection dies during TOP');
  testAccount.do_viewFolder(
    'syncs', inboxFolder,
    { count: 0, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: 0 },
    {
      failure: 'deadconn', batches: 0,
      expectFunc: function() {
        FawltySocketFactory.precommand(
          testAccount.pop3Host, testAccount.pop3Port,
          { cmd: 'close-on-send', match: /TOP/ });
      }
    });

  // - Die during processing the message, triggering disaster_recovery
  // This is notable because this will occur without any `pendingRequests` so
  // we need an overarching 'onclose' handle to trigger this failure mode.
  //
  // We induce a failure here by forcing parseMime to throw an exception.  We
  // do this by clobbering the method. so...
  // NOTE NOTE NOTE this has to be the last test because we clobber a prototype
  // and we don't care about the fallout!
  T.group('connection dies because of disaster recovery');
  testAccount.do_viewFolder(
    'syncs', inboxFolder,
    { count: 0, full: 0, flags: 0, changed: 0, deleted: 0 },
    { top: true, bottom: true, grow: false, newCount: 0 },
    {
      // we explicitly say batches: 0 here too because we did get far enough to
      // do the UIDL thing above.
      failure: 'deadconn', batches: 0,
      expectFunc: function() {
        // Make sure disaster recover is getting its chance to shine
        T.actor('DisasterRecovery').expect('exception', function(details) {
          return (details.errorMessage === 'ARTIFICE');
        });

        $pop3.Pop3Client.prototype.parseMime = function() {
          throw new Error('ARTIFICE');
        };
      }
    });

  T.group('cleanup');
});

}); // end define
