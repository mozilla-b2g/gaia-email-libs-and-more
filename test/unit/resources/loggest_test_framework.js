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

/**
 * Define a test that wants one or more IMAP folders of its own.  At the start
 * of the test we then create the given folders and fill them with messages
 * as requested by the folder definitions by using APPEND.
 *
 * Because xpcshell has limited cleanup capabilities (synchronous functions
 * only) and we don't actually want concurrent tests anyways, what we do is
 * consistently name the folders by using the test function's name and
 * concatenating the number of the folder to that name.  If said folder
 * already exists when we are setting up the test, we nuke it.
 *
 * In order to try and keep setup overhead out of our timings, we break the
 * setup out into its own test step.
 *
 * Once that's all done we invoke the test function which is responsible for
 * calling xpcshell's run_next_test() once it is finished.
 */
function add_imap_folder_test(folderDefs, testFunc) {
  // Always set the date to today at noon...
  var useDate = new Date();
  useDate.setHours(12, 0, 0, 0);
  var generator = null,
      folderPaths = [], storages = [], corpuses = [],
      rawAccount = null,
      iDef = 0;

  function processNextFolder() {
    if (iDef >= folderDefs.length) {
      run_next_test();
      return;
    }
    var folderName = 'ut_' + testFunc.name + '_' + iDef;

  }

add_test(function setup_imap_using_test() {
  processNextFolder();
});
// By using bind, we maintain the function's name while also being able to
// provide it with arguments.
add_test(testFunc.bind(folderPaths, storages, corpuses));
}

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
