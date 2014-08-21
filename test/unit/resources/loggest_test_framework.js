/**
 * Helper logic to initialize a MailAPI/MailUniverse environment.  This
 * performs a similar function to same-frame-setup.js but customized to
 * the unit test environment.
 **/

// prefixing everything since we are running in the global scope and I don't
// want the modules to accidentally see these because of a lack of shadowing.
var $_mailuniverse = require('mailuniverse'),
    $_accountcommon = require('accountcommon'),
    $_mailbridge = require('mailbridge'),
    $_mailapi = require('mailapi'),
    $_allback = require('allback'),
    $_date = require('date'),
    $_syncbase = require('syncbase'),
    $_imapfolder = require('imap/folder'),
    $_mailslice = require('mailslice'),
    $_quotechew = require('quotechew'),
    $_wbxml = require('activesync/wbxml/wbxml'),
    $_ascp = require('activesync/codepages'),
    $tc = require('rdcommon/testcontext'),
    $_testdriver = require('rdcommon/testdriver'),
    $th_imap = require('testhelper');

// this is relative to our caller, which is a bit crap, but should be fine
load('resources/messageGenerator.js');
load('../activesync_server.js');

var MailAPI = null, MailBridge = null, MailUniverse = null;

var gAllAccountsSlice = null, gAllFoldersSlice = null;

var gDumpedLogs = false, gRunner;
function dumpAsUtf8WithNewline(s) {
  try {
    var converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                      .createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";
    var u8s = converter.ConvertFromUnicode(s);
    print(u8s);
    print('(printed ' + u8s.length + ' bytes from ' + s.length + ')');
  }
  catch(ex) {
    console.error('Problem converting output to utf-8:', ex);
  }
}
ErrorTrapper.reliableOutput = dumpAsUtf8WithNewline;
function dumpLogs() {
  if (!gDumpedLogs) {
    gRunner.dumpLogResultsToConsole(dumpAsUtf8WithNewline);
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
    defaultStepDuration: (TEST_PARAMS_ARE_DEFAULTS ? 1 : 3) * 1000,
    maxTestDurationMS: 10 * 1000,
    maxTotalDurationMS: 20 * 1000,
    exposeToTest: {},
  };
  gRunner = new $_testdriver.TestDefinerRunner(
    TD, true, options);
  gRunner.runAll(ErrorTrapper, options.defaultStepDuration)
    .then(function success() {
      dumpLogs();
      do_check_true(true);
      do_test_finished();
    }, function failure() {
      do_throw('A test failed!');
      do_test_finished();
    });
}
