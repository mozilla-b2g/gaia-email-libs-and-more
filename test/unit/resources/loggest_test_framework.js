/**
 * Helper logic to initialize a MailAPI/MailUniverse environment.  This
 * performs a similar function to same-frame-setup.js but customized to
 * the unit test environment.
 **/

// prefixing everything since we are running in the global scope and I don't
// want the modules to accidentally see these because of a lack of shadowing.
var $_mailuniverse = require('rdimap/imapclient/mailuniverse'),
    $_mailbridge = require('rdimap/imapclient/mailbridge'),
    $_mailapi = require('rdimap/imapclient/mailapi'),
    $_allback = require('rdimap/imapclient/allback'),
    $_Q = require('q'),
    $tc = require('rdcommon/testcontext'),
    $_testdriver = require('rdcommon/testdriver'),
    $th_imap = require('rdimap/imapclient/testhelper');

var MailAPI = null, MailBridge = null, MailUniverse = null;

var gAllAccountsSlice = null, gAllFoldersSlice = null;

var gDumpedLogs = false, gRunner;
function dumpLogs() {
  if (!gDumpedLogs) {
    gRunner.dumpLogResultsToConsole(print);
    gDumpedLogs = true;
  }
}
function runMyTests(maxRunInSecs) {
  // This should now be handled by ErrorTrapper generating an exit event.
  //do_register_cleanup(dumpLogs);
  do_test_pending();
  setTimeout(function() {
    dumpLogs();
    do_throw('timeout!');
  }, maxRunInSecs * 1000);
  var options = {
    testMode: 'test',
    defaultStepDuration: 1 * 1000,
    maxTestDurationMS: 10 * 1000,
    maxTotalDurationMS: 20 * 1000,
    exposeToTest: {},
  };
  gRunner = new $_testdriver.TestDefinerRunner(
    TD, true, options);
  $_Q.when(gRunner.runAll(ErrorTrapper),
           function success() {
             dumpLogs();
             do_check_true(true);
             do_test_finished();
           },
           function failure() {
             do_throw('A test failed!');
             do_test_finished();
           });
}
