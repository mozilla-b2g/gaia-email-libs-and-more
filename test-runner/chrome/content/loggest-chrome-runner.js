/**
 * Minimal test running framework.
 *
 * We:
 * - turn off things that might needlessly mess with the test
 * - use a test runner that can be run from content / anywhere
 * - augment the error reporting capabilities of the test runner by listening to
 *   the console service and friends
 * - use a custom protocol so we get a distinct appId/origin per test file
 * - install the app; we used to manually turn on the privileges using a list
 *   from within this file, but now it'a all from the manifest.
 * - make sure devicestorage uses our profile directory rather than randomly
 *   touching the FS.
 * - write the test log
 *
 * This file is currently a little soupy; various logic is all mixed in here.
 * There has been some recent cleanup; check the file history if you're missing
 * something chrome-privilege-related.
 **/
try {
dump("LOADING!\n");
console.harness('loading stuff');

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;
const CC = Components.Constructor;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

Cu.import("resource://gre/modules/osfile.jsm");

////////////////////////////////////////////////////////////////////////////////
// Import important services that b2g's shell.js loads
//
// For example, if we want mozAlarms to work, we have to import its service!
// (Commented out stuff was in shell.js but we don't think we need it or
// absolutely don't want it.)
Cu.import('resource://gre/modules/ContactService.jsm');
Cu.import('resource://gre/modules/SettingsChangeNotifier.jsm');
Cu.import('resource://gre/modules/DataStoreChangeNotifier.jsm');
Cu.import('resource://gre/modules/AlarmService.jsm');
Cu.import('resource://gre/modules/ActivitiesService.jsm');
Cu.import('resource://gre/modules/NotificationDB.jsm');
//Cu.import('resource://gre/modules/Payment.jsm');
Cu.import("resource://gre/modules/AppsUtils.jsm");
//Cu.import('resource://gre/modules/UserAgentOverrides.jsm');
//Cu.import('resource://gre/modules/Keyboard.jsm');
//Cu.import('resource://gre/modules/ErrorPage.jsm');
//Cu.import('resource://gre/modules/AlertsHelper.jsm');

Cu.import('resource://gre/modules/Webapps.jsm');
DOMApplicationRegistry.allAppsLaunchable = true;

const IOService = CC('@mozilla.org/network/io-service;1', 'nsIIOService')();
const URI = IOService.newURI.bind(IOService);

/**
 * Old-style Promises defer method for minimal code changes.
 */
function defer() {
  var deferred = {};
  deferred.promise = new Promise(function(resolve, reject) {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  return deferred;
}

////////////////////////////////////////////////////////////////////////////////
console.log('Initial loggest-chrome-runner.js bootstrap begun');

////////////////////////////////////////////////////////////////////////////////
// Error handling support; call directly into the page's ErrorTrapper
//
// Currently all the logs are maintained from within the page/iframe.  So if we
// want to have system-wide stuff in the log, we need to call into the page
// itself.

const nsIScriptError = Ci.nsIScriptError;

var gRunnerWindow, gFakeParent;

var ErrorTrapperHelper = {
  observe: function (aMessage, aTopic, aData) {
    if (aTopic == "profile-after-change")
      return;
    else if (aTopic == "quit-application") {
      this.unhookConsoleService();
      return;
    }

    try {
      if (aMessage instanceof nsIScriptError) {
        // The CSS Parser just makes my life sad.
        if (aMessage.category == "CSS Parser")
          return;

        if (aMessage.flags & nsIScriptError.warningFlag)
          return;
        if (aMessage.flags & nsIScriptError.strictFlag)
          return;

         console.error(aMessage.errorMessage + ' [' + aMessage.category + ']',
                      aMessage.sourceName, aMessage.lineNumber);

        if (gRunnerWindow && gRunnerWindow.wrappedJSObject &&
            gRunnerWindow.wrappedJSObject.ErrorTrapper) {
          gRunnerWindow.ErrorTrapper.fire(
            'uncaughtException',
            {
              name: 'ConsoleError',
              message: aMessage.errorMessage + ' [' + aMessage.category +
                ']',
              stack: [
                {
                  filename: aMessage.sourceName,
                  lineNo: aMessage.lineNumber,
                  funcName: '',
                }
              ]
            });
        }
      }
    } catch (ex) {
      if (!/can't access dead object/.test(ex.message)) {
        dump("SELF-SPLOSION: " + ex + "\n" + ex.stack + "\n");
      }
    }
  },

  /**
   * The console service is where app-wide errors and such are logged.  Gecko
   * has been getting better at directing per-tab(/window) errors to the actual
   * tab in question, or at least tagging them appropriately so the devtools
   * can be smart.  So... TODO: make sure we are up-to-date with the console
   * idiom.  (Alternately, change over to using whatever Gaia starts using for
   * unit tests.)
   */
  hookConsoleService: function() {
    this.consoleService = Cc["@mozilla.org/consoleservice;1"]
                            .getService(Ci.nsIConsoleService);
    this.consoleService.registerListener(this);

    // We need to unregister our listener at shutdown if we don't want
    //  explosions
    this.observerService = Cc["@mozilla.org/observer-service;1"]
                             .getService(Ci.nsIObserverService);
    this.observerService.addObserver(this, "quit-application", false);
  },
  unhookConsoleService: function () {
    this.consoleService.unregisterListener(this);
    this.observerService.removeObserver(this, "quit-application");
    this.consoleService = null;
    this.observerService = null;
  },
};
ErrorTrapperHelper.hookConsoleService();

////////////////////////////////////////////////////////////////////////////////
// xpcshell head.js choice logic

// Disable automatic network detection, so tests work correctly when
// not connected to a network.
let (ios = Components.classes["@mozilla.org/network/io-service;1"]
           .getService(Components.interfaces.nsIIOService2)) {
  ios.manageOfflineStatus = false;
  ios.offline = false;
}

// Disable IPv6 lookups for 'localhost' on windows.
try {
  if ("@mozilla.org/windows-registry-key;1" in Components.classes) {
    let processType = Components.classes["@mozilla.org/xre/runtime;1"].
      getService(Components.interfaces.nsIXULRuntime).processType;
    if (processType == Components.interfaces.nsIXULRuntime.PROCESS_TYPE_DEFAULT) {
      let (prefs = Components.classes["@mozilla.org/preferences-service;1"]
                   .getService(Components.interfaces.nsIPrefBranch)) {
        prefs.setCharPref("network.dns.ipv4OnlyDomains", "localhost");
      }
    }
  }
}
catch (e) { }

/**
 * Overrides idleService with a mock.  Idle is commonly used for maintenance
 * tasks, thus if a test uses a service that requires the idle service, it will
 * start handling them.
 * This behaviour would cause random failures and slowdown tests execution,
 * for example by running database vacuum or cleanups for each test.
 *
 * @note Idle service is overridden by default.  If a test requires it, it will
 *       have to call do_get_idle() function at least once before use.
 */
var _fakeIdleService = {
  get registrar() {
    delete this.registrar;
    return this.registrar =
      Components.manager.QueryInterface(Components.interfaces.nsIComponentRegistrar);
  },
  contractID: "@mozilla.org/widget/idleservice;1",
  get CID() this.registrar.contractIDToCID(this.contractID),

  activate: function FIS_activate()
  {
    if (!this.originalFactory) {
      // Save original factory.
      this.originalFactory =
        Components.manager.getClassObject(Components.classes[this.contractID],
                                          Components.interfaces.nsIFactory);
      // Unregister original factory.
      this.registrar.unregisterFactory(this.CID, this.originalFactory);
      // Replace with the mock.
      this.registrar.registerFactory(this.CID, "Fake Idle Service",
                                     this.contractID, this.factory
      );
    }
  },

  deactivate: function FIS_deactivate()
  {
    if (this.originalFactory) {
      // Unregister the mock.
      this.registrar.unregisterFactory(this.CID, this.factory);
      // Restore original factory.
      this.registrar.registerFactory(this.CID, "Idle Service",
                                     this.contractID, this.originalFactory);
      delete this.originalFactory;
    }
  },

  factory: {
    // nsIFactory
    createInstance: function (aOuter, aIID)
    {
      if (aOuter) {
        throw Components.results.NS_ERROR_NO_AGGREGATION;
      }
      return _fakeIdleService.QueryInterface(aIID);
    },
    lockFactory: function (aLock) {
      throw Components.results.NS_ERROR_NOT_IMPLEMENTED;
    },
    QueryInterface: function(aIID) {
      if (aIID.equals(Components.interfaces.nsIFactory) ||
          aIID.equals(Components.interfaces.nsISupports)) {
        return this;
      }
      throw Components.results.NS_ERROR_NO_INTERFACE;
    }
  },

  resetIdleTimeOut: function(idleDeltaInMS) {
  },

  // nsIIdleService
  get idleTime() 0,
  addIdleObserver: function () {},
  removeIdleObserver: function () {},


  QueryInterface: function(aIID) {
    // Useful for testing purposes, see test_get_idle.js.
    if (aIID.equals(Components.interfaces.nsIFactory)) {
      return this.factory;
    }
    if (aIID.equals(Components.interfaces.nsIIdleService) ||
        aIID.equals(Components.interfaces.nsIIdleServiceInternal) ||
        aIID.equals(Components.interfaces.nsISupports)) {
      return this;
    }
    throw Components.results.NS_ERROR_NO_INTERFACE;
  }
};

_fakeIdleService.activate();

/**
 * Given a path relative to the GELAM root, return an nsIFile corresponding to
 * that path.
 */
function do_get_file(path, allowNonexistent) {
  try {
    let lf = Components.classes["@mozilla.org/file/directory_service;1"]
      .getService(Components.interfaces.nsIProperties)
      .get("CurWorkD", Components.interfaces.nsILocalFile);

    let bits = path.split("/");
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) {
        if (bits[i] == "..")
          lf = lf.parent;
        else
          lf.append(bits[i]);
      }
    }

    if (!allowNonexistent && !lf.exists()) {
      var stack = Components.stack.caller;
      dump("Problem locating file | " + stack.filename + " | [" +
            stack.name + " : " + stack.lineNumber + "] " + lf.path +
            " does not exist\n");
    }

    return lf;
  }
  catch (ex) {
    console.error('do_get_file problem:', ex, '\n', ex.stack);
  }

  return null;
}

// Map resource://test/ to current working directory and
// resource://testing-common/ to the shared test modules directory.
function register_resource_alias(alias, file) {
  let (ios = Components.classes["@mozilla.org/network/io-service;1"]
             .getService(Components.interfaces.nsIIOService)) {
    let protocolHandler =
      ios.getProtocolHandler("resource")
         .QueryInterface(Components.interfaces.nsIResProtocolHandler);
    let dirURI = ios.newFileURI(file);
    console.harness('adding resources alias:', alias, 'to', dirURI.path);
    protocolHandler.setSubstitution(alias, dirURI);
  };
}

register_resource_alias('fakeserver', do_get_file('node_modules/mail-fakeservers/xpcom'));
register_resource_alias('activesync', do_get_file('js/ext/activesync-lib'));


////////////////////////////////////////////////////////////////////////////////
// Test parameters passed in via environment variables / command line
//
// The goal is to allow our unit tests to be run against varying server
// configurations, etc.
//
// We started out using environment variables, but now try to support command
// line arguments too.
//
// --test-name is a required argument currently.


function parseBoolean(s) {
  if (!s)
    return false;
  return s.toLowerCase() === 'true';
}

const ENVIRON_MAPPINGS = [
  // ex: '*@fakehost' for fake-server, 'testy@localhost' for local real
  // IMAP server, '*@aslocalhost' for an activesync localhost account which
  // implies a fake-server that you're already running.
  {
    name: 'emailAddress',
    envVar: 'GELAM_TEST_ACCOUNT',
    coerce: function (x) { return x; },
  },
  {
    name: 'password',
    envVar: 'GELAM_TEST_PASSWORD',
    coerce: function (x) { return x; },
  },
  // 'imap' or 'pop3' or 'activesync'
  {
    name: 'type',
    envVar: 'GELAM_TEST_ACCOUNT_TYPE',
    coerce: function (x) { return x; },
  },
  {
    name: 'slow',
    envVar: 'GELAM_TEST_ACCOUNT_SLOW',
    coerce: Boolean
  },
  {
    name: 'logFailuresOnly',
    envVar: 'GELAM_LOG_FAILURES_ONLY',
    coerce: Boolean
  },
  {
    name: 'printTravisUrls',
    envVar: 'GELAM_PRINT_TRAVIS_URLS',
    coerce: function (x) { return x; }
  }
];
var TEST_PARAMS = {
  name: 'Baron von Testendude',
  emailAddress: null,
  password: null,
  slow: false,
  type: null,

  defaultArgs: true,

  testLogEnable: true,

  logFailuresOnly: false,
  printTravisUrls: false,
};

var TEST_NAME = null;
var TEST_CONFIG = null;
/**
 * Command issued via an argument that causes us to not actually run a test, but
 * causes us to spin up a fake-server using the same infrastructure we would
 * have used to spin it up from a unit test.
 */
var TEST_COMMAND = null;

// Trigger just one variant of tests to run.
var TEST_VARIANT = null;

var chromeWindow = window.parent;

/**
 * Pull test name and arguments out of command-line and/or environment
 */
function populateTestParams() {
  let args = chromeWindow.arguments[0].QueryInterface(Ci.nsICommandLine);

  // the second argument to handleFlagWithParam is case sensitivity.
  var caseInsensitive = false;

  // test-name is optional
  if (args.findFlag('test-name', false) !== -1)
    TEST_NAME = args.handleFlagWithParam('test-name', caseInsensitive)
                  .replace(/\.js$/, '');
  else
    TEST_NAME = null;
  // but the configuration is not
  TEST_CONFIG = args.handleFlagWithParam('test-config', caseInsensitive);
  // make absolute if it's not already absolute
  if (TEST_CONFIG[0] !== '/')
    TEST_CONFIG = do_get_file(TEST_CONFIG).path;

  // variant is optional
  if (args.findFlag('test-variant', false) !== -1)
    TEST_VARIANT = args.handleFlagWithParam('test-variant', caseInsensitive);
  if (TEST_VARIANT === 'all')
    TEST_VARIANT = null;

  // log-enable is optional
  if (args.findFlag('test-log-enable', false) !== -1)
    TEST_PARAMS.testLogEnable =
      parseBoolean(args.handleFlagWithParam('test-log-enable',
                                            caseInsensitive));

  // test-command is optional
  if (args.findFlag('test-command', false) !== -1)
    TEST_COMMAND = args.handleFlagWithParam('test-command', caseInsensitive);

  let environ = Cc["@mozilla.org/process/environment;1"]
                  .getService(Ci.nsIEnvironment);
  for each (let [, {name, envVar, coerce}] in Iterator(ENVIRON_MAPPINGS)) {
    let argval = args.handleFlagWithParam('test-param-' + name,
                                          caseInsensitive);
    if (argval) {
      TEST_PARAMS[name] = coerce(argval);
      console.harness('command line:', name, TEST_PARAMS[name]);
      if (name !== 'type')
        TEST_PARAMS.defaultArgs = false;
    }
    else if (environ.exists(envVar)) {
      TEST_PARAMS[name] = coerce(environ.get(envVar));
      console.harness('environment:', name, TEST_PARAMS[name]);
      if (name !== 'type')
        TEST_PARAMS.defaultArgs = false;
    }
  }
}
populateTestParams();
window.console._enabled = TEST_PARAMS.testLogEnable;

////////////////////////////////////////////////////////////////////////////////
// make device storage operate out of our test-profile dir!
//
// We create/use one directory per test file/variant.  Tests Cases in the same
// file use the same DeviceStorage.
//
// There's a lot of mooted logic that you can pull out of the git log if this
// stuff breaks again.

var dirService = Cc["@mozilla.org/file/directory_service;1"]
                   .getService(Ci.nsIProperties);
function makeAndSetDeviceStorageTarget(subdirName) {
  // We need to turn off device.storage.testing for nsDeviceStorage.cpp's
  // OverrideRootDir::Init method to let us control the directory in the way we
  // want.  (The logic in there is somewhat confusing; it seems like weird stuff
  // can happen if this pref were to get dynamically toggled back to false, so
  // let's never do that.)
  // NB: Accordingly we just set this pref in our prefs.js
  //Services.prefs.setBoolPref('device.storage.testing', false);

  // OverrideRootDir uses NS_NewLocalFile which requires a relative path, so
  // we need to do the resolution ourselves.

  var deviceStorageFile = dirService.get('ProfD', Ci.nsIFile);
  deviceStorageFile.append('device-storage');
  deviceStorageFile.append(subdirName);
  console.harness('Setting device-storage path to', deviceStorageFile.path);

  // OverrideRootDir likes to create the directory for us, so we don't need to
  // create it.  But we do need to delete it and any existing contents to
  // avoid weirdness
  //deviceStorageFile.create(Ci.nsIFile.DIRECTORY_TYPE, parseInt('777', 8));
  if (deviceStorageFile.exists()) {
    deviceStorageFile.remove(/* recursive */ true);
  }


  Services.prefs.setCharPref(
    'device.storage.overrideRootDir', deviceStorageFile.path);
}

////////////////////////////////////////////////////////////////////////////////
// permissions
//
// We used to explicitly authorize our test origin for all the permissions that
// we had copied from our manifest into EMAIL_PERMISSIONS.  We now explicitly
// just install our app and use what's in its manifest.
//
// I'm leaving this permissions stuff in place for now since just because an app
// wants a permission doesn't mean it automatically gets it.  The user might
// get prompted, we may want that prompt to be part of the test, etc.
//
// For now, however, the assumption is that the manifest install hooked us up.

var EMAIL_PERMISSIONS = {
};

/**
 * Convert an nsIArray to a JS array, making sure to QueryInterface the elements
 * so they don't just look like nsISupports-exposed objects.
 */
function convertNsIArray(arr, elemType) {
  var out = [];
  arr = arr.QueryInterface(Ci.nsIArray);
  for (var i = 0; i < arr.length; i++) {
    out.push(arr.queryElementAt(i, elemType));
  }
  return out;
}

var FakeContentPermissionPrompt = {
  prompt: function(request) {
    var types;
    // Current rep.
    if (request.types) {
      // It's an nsIArray, which does not map cleanly to JS; use our helper.
      types = convertNsIArray(request.types, Ci.nsIContentPermissionType);
    }
    // Pre-bug 853356 rep
    else {
      types = [{ type: request.type, access: request.access }];
    }

    var allowCount = 0;
    var denyCount = 0;
    types.forEach(function(requestType) {
      if (EMAIL_PERMISSIONS.hasOwnProperty(requestType.type)) {
        console.harness('Allowing sub-permission:', requestType.type, 'for',
                        requestType.access, 'to', request.principal.origin);
        allowCount++;
      }
      else {
        console.harness('Denying sub-permission', requestType.type, 'for',
                        requestType.access, 'to', request.principal.origin);
        denyCount++;
      }
    });
    // Any denial means we should deny the whole thing since our goal is to
    // get a heads-up when we need to update our webapp.manifest.
    if (denyCount) {
      console.warn('Denying overall permission request.');
      request.cancel();
      if (allowCount) {
        console.warn('Denied request because of', denyCount, 'denials,',
                     'but there were', allowCount, 'allowals.');
      }
    }
    else {
      console.warn('Allowing overall permission request.');
      request.allow();
    }
  },

  createInstance: function createInstance(outer, iid) {
    if (outer != null)
      throw Components.results.NS_ERROR_NO_AGGREGATION;
    return this.QueryInterface(iid);
  },

  classID: Components.ID("{d56fec31-dc7a-4526-9e12-a722f3effb3b}"),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIContentPermissionPrompt])
};

let componentRegistrar =
      Components.manager.QueryInterface(Ci.nsIComponentRegistrar);

// WE NO LONGER USE OUR FAKE COMPONENT REGISTRAR SINCE WE ARE DOING THE EXPLICIT
// APP INSTALL STUFF ABOVE.  However, this seems like the type of thing we may
// need to dig out again in the near future or for debugging purposes, so
// leaving it around for now, just hard-disabled.
/*
componentRegistrar.registerFactory(
  Components.ID("{d56fec31-dc7a-4526-9e12-a722f3effb3b}"),
  "Fake Content Permission Prompt Service",
  "@mozilla.org/content-permission/prompt;1",
  FakeContentPermissionPrompt);
*/

function grantEmailPermissions(originUrl) {
  var perm = Cc["@mozilla.org/permissionmanager;1"]
               .createInstance(Ci.nsIPermissionManager);
  var uri = URI(originUrl, null, null);
  for (var permName in EMAIL_PERMISSIONS) {
    perm.add(uri, permName, 1);
  }
}

////////////////////////////////////////////////////////////////////////////////
// Add some debug logging related to garbage collections, etc.

function trackGarbageCollection() {
  Services.prefs.setBoolPref('javascript.options.mem.notify', true);
  Services.obs.addObserver(
    function(subject, topic, json) {
      console.harness('~~~ GC completed ~~~');
    },
    'garbage-collection-statistics', /* strong */ false);
  Services.obs.addObserver(
    function(subject, topic, json) {
      console.harness('~~~ CC completed ~~~');
    },
    'cycle-collection-statistics', /* strong */ false);
}
trackGarbageCollection();

////////////////////////////////////////////////////////////////////////////////

const loader = Cc[
  '@mozilla.org/moz/jssubscript-loader;1'
].getService(
  Components.interfaces.mozIJSSubScriptLoader
);

loader.loadSubScript('resource://fakeserver/fake-server-support.js');

////////////////////////////////////////////////////////////////////////////////

const appStartup = Cc['@mozilla.org/toolkit/app-startup;1']
                     .getService(Ci.nsIAppStartup);
function quitApp() {
  appStartup.quit(Ci.nsIAppStartup.eForceQuit);
}

function buildQuery(args) {
  var bits = [];
  for (var key in args) {
    bits.push(encodeURIComponent(key) + "=" + encodeURIComponent(args[key]));
  }
  return bits.join("&");
};

/**
 * Create a summary object for the given log run.
 */
function summaryFromLoggest(testFileName, variant, logData) {
  var summary = {
    filename: testFileName,
    result: null,
    tests: []
  };
  var anyFailures = false;
  try {
    if (logData.fileFailure) {
      summary.tests.push({
        name: '*file level problem*',
        result: 'fail',
        // in the case of a file failure, we need the variant hint...
        variant: variant
      });
      anyFailures = true;
    }
    var definerLog = logData.log;

    // we're currently pre-toJSON, so we need to directly look at the loggers;
    // this will need to be changed up pretty shortly.
    if (!definerLog || !definerLog.kids)
      return summary;
    for (var iKid = 0; iKid < definerLog.kids.length; iKid++) {
      var testCaseLog = definerLog.kids[iKid];
      var testPermLog = testCaseLog.kids[0];

      var result = testCaseLog.latched.result;
      if (result === 'fail') {
        anyFailures = true;
      }

      // try and generate a concise summary of what failed.  In this case, we
      // pick the step that failed to report.
      var firstFailedStep = null;
      if (result === 'fail' && testPermLog.kids) {
        for (var iStep = 0; iStep < testPermLog.kids.length; iStep++) {
          var step = testPermLog.kids[iStep];
          if (step.latched && step.latched.result === 'fail') {
            firstFailedStep = '' + step.semanticIdent;
            break;
          }
        }
      }

      summary.tests.push({
        name: '' + testCaseLog.semanticIdent,
        result: result,
        // although the latched variant should match up with the passed-in
        // variant, let's avoid non-obvious clobbering and just propagate
        variant: testPermLog.latched.variant,
        firstFailedStep: firstFailedStep
      });
    }
  }
  catch (ex) {
    console.harness('Problem generating loggest summary:', ex, '\n', ex.stack);
  }

  if (anyFailures) {
    summary.result = 'fail';
  }

  return summary;
}

function printTestSummary(summary) {
  dump('Test: ' + summary.filename + '\n');
  summary.tests.forEach(function(test) {
    var str = '    ';
    switch (test.result) {
      case 'pass':
        str += '\x1b[32mPASS';
        break;
      case 'fail':
        str += '\x1b[31mFAIL';
        break;
      case 'skip':
        str += '\x1b[33mSKIP';
        break;
      default:
        str += '??? ' + test.result + '???';
        break;
    }
    str += '\x1b[0m ' + test.name + ' (' + test.variant + ')\n';
    dump(str);

    // (brief) failure details:
    if (test.result === 'fail') {
      dump('             failing step: ' + test.firstFailedStep + '\n');

      if (TEST_PARAMS.printTravisUrls && summary._filename) {
        dump('    http://clicky.visophyte.org/tools/arbpl-standalone/?log=' +
             TEST_PARAMS.printTravisUrls + summary._filename + '\n');
      }
    }
  });
}

function getTestResult(summaries) {
  var result = 'success';

  summaries.forEach(function(summary) {
    summary.tests.forEach(function(test) {
      if (test.result !== 'pass') {
        result = 'failure';
      }
    });
  });

  return result;
}

// Progress listeners are held weakref'ed, so we need to maintain a strong
// reference here or it can go away prematurely!
var gProgress = null;
var gIframe = null;

/**
 * Given our URI figure out what appId we ended up assigning to our app.
 */
function resolveUriToAppId(uri) {
  // lucky for us there's really only one manifest so its path is easy to
  // figure out.
  var manifestUrl = uri.prePath + '/test/manifest.webapp';
  var appId =  DOMApplicationRegistry.getAppLocalIdByManifestURL(manifestUrl);
  // dump ("!! appId is " + appId + " for " + manifestUrl + "\n");
  return appId;
}

/**
 * @param controlServer The ControlServer to point the test at.
 */
function runTestFile(testFileName, variant, controlServer) {
  try {
    return _installTestFileThenRun(testFileName, variant, controlServer);
  }
  catch(ex) {
    console.error('Error in runTestFile', ex, '\n', ex.stack);
    throw ex;
  }
};
function _installTestFileThenRun(testFileName, variant, controlServer) {
  // Our testfile protocol allows us to use the test file as an origin, so every
  // test file gets its own instance of the e-mail database.  This is better
  // than deleting the database every time because at the end of the run we
  // will have all the untouched IndexedDB databases around so we can poke at
  // them if we need/want.
  var baseUrl = 'testfile://' + testFileName + '-' +
                  variant.replace(/:/g, '_') + '/';

  var manifestUrl = baseUrl + 'test/manifest.webapp';

  // So, if one is playing by the rules, then one
  // uses navigator.mozApps.install().  However, that method really wants us to
  // be using an nsIHttpChannel or nsIJarChannel to get the XHR status and for
  // us to pass some other checks.  It just so happens that being
  // super-privileged like ourselves we can bypass that BS and just directly
  // force the issue.
  console.harness('Force installing app at', manifestUrl);
  // This data-structure is normally created by dom/apps/src/Webapps.js'
  // WebappsRegistry._prepareInstall
  var data = {
    app: {
      installOrigin: baseUrl,
      origin: baseUrl, // used
      manifestURL: manifestUrl, // used
      receipts: [],
      categories: []
      // not used by us: 'localInstallPath' ?
    },

    from: baseUrl, // unused?
    oid: 0, // unused?
    requestID: 0, // unused-ish
    appId: 0, // unused
    isBrowser: false,
    isPackage: false, // used
    // magic to auto-ack... don't think we care about this...
    forceSuccessAck: false
    // stuff that probably doesn't matter: 'mm', 'apkInstall',
  };

  return OS.File.read('test/manifest.webapp').then(function(arr) {
    var manifestStr = new TextDecoder().decode(arr);
    data.app.manifest = JSON.parse(manifestStr);
    console.harness('got manifest!');
    return DOMApplicationRegistry.confirmInstall(data).then(
      function() {
        console.harness('installed!! compelling permissions');
        // act like this is a privileged app having all of its permissions
        // authorized at first run.
        DOMApplicationRegistry.updatePermissionsForApp(
          resolveUriToAppId(manifestUrl),
          /* preinstalled */ true,
          /* system update? */ true);
        console.harness('permissions compelled');
        return _runTestFile(testFileName, variant, baseUrl, manifestUrl,
                            controlServer);
      },
      function(err) {
        console.error('install failure!', err, '\n', err.stack);
      });
  });
};
function _runTestFile(testFileName, variant, baseUrl, manifestUrl, controlServer) {
  console.harness('running', testFileName, 'variant', variant);

  // Parameters to pass into the test.
  var testParams;
  switch (variant) {
    case 'imap:fake':
      testParams = {
        name: 'Baron von Testendude',
        emailAddress: 'testy@fakeimaphost',
        emailDomain: 'fakeimaphost',
        password: 'testy',
        slow: false,
        type: 'imap',

        defaultArgs: true,

        controlServerBaseUrl: controlServer.baseUrl,
      };
      break;
    case 'pop3:fake':
      testParams = {
        name: 'Baron von Testendude',
        emailAddress: 'testy@fakepop3host',
        emailDomain: 'fakepop3host',
        password: 'testy',
        slow: false,
        type: 'pop3',

        defaultArgs: true,

        controlServerBaseUrl: controlServer.baseUrl,
      };
      break;
    case 'activesync:fake':
      testParams = {
        name: 'Baron von Testendude',
        emailAddress: 'testy@fakeashost',
        emailDomain: 'fakeashost',
        password: 'testy',
        slow: false,
        type: 'activesync',

        defaultArgs: true,

        controlServerBaseUrl: controlServer.baseUrl,
      };
      break;
    // these variants should only be run if info has been provided explicitly
    case 'imap:real':
      testParams = TEST_PARAMS;
      break;
    case 'activesync:real':
      testParams = TEST_PARAMS;
      break;
    case 'imap:noserver':
      testParams = {type: 'imap'};
      break;
    case 'pop3:noserver':
      testParams = {type: 'pop3'};
      break;
    case 'noserver':
    default:
      testParams = {};
      break;
  }

  testParams.variant = variant;
  testParams.testLogEnable = TEST_PARAMS.testLogEnable;

  var passToRunner = {
    testName: testFileName,
    testParams: JSON.stringify(testParams),
  };

  // This would matter if we actually could control where the sdcard storage
  // went, which we can't. Uggggggh.  For now, th_devicestorage just runs
  // a cleanup pass where it deletes everything it saw get created.
  makeAndSetDeviceStorageTarget(
    testFileName + '-' + variant.replace(/:/g, '_'));

  var runnerIframe = gIframe = document.createElement('iframe');
  //runnerIframe.setAttribute('type', 'content');
  runnerIframe.setAttribute('flex', '1');
  runnerIframe.setAttribute('style', 'border: 1px solid blue;');

  var win, domWin;

  var deferred = defer();

  var cleanupList = [];
  if (controlServer)
    cleanupList.push(controlServer);

  function cleanupWindow() {
    try {
      console.harness('!! cleanupWindow; removing iframe');
      runnerIframe.parentNode.removeChild(runnerIframe);

      cleanupList.forEach(function(obj) {
        obj.cleanup();
      });
    }
    catch(ex) {
      console.harness('Problem cleaning up window', ex, '\n', ex.stack);
    }
  }

  var processedLog = false;
  var logListener = function(event) {
    if (processedLog) {
      console.harness('WARNING: Already got a processed log!');
      return;
    }
    processedLog = true;

    console.harness('calling writeTestLog and resolving');
    var jsonStr = event.data.data,
        logData = JSON.parse(jsonStr);
    // this must be done prior to the compartment getting killed
    var summary = summaryFromLoggest(testFileName, variant, logData);
    if (!TEST_PARAMS.logFailuresOnly || summary.result === 'fail') {
      writeTestLog(testFileName, variant, jsonStr, summary).then(
        function() {
          console.harness('write completed!');
          deferred.resolve(summary);
        });
    }
    else {
      console.harness('not a failure, not writing');
      deferred.resolve(summary);
    }

    // cleanup may kill things, so don't do this until after the above
    // functions have been able to snapshot the log
    console.harness('cleaning up window');
    cleanupWindow();
  };

  var errorListener = function errorListener(errorMsg, url, lineNumber) {
    console.harness('win err:', errorMsg, url, lineNumber);
  };

  console.harness('about to set src');
  runnerIframe.setAttribute('mozbrowser', 'true');
  runnerIframe.setAttribute('mozapp', manifestUrl);


  // The ones where we're not doing anything exist so we can have the logging
  // to see if anything weird is happening.
  runnerIframe.addEventListener('mozbrowserloadstart', function() {
    console.harness('!! load start');
  });
  runnerIframe.addEventListener('mozbrowserlocationchange', function() {
    console.harness('!! location change');
  });
  runnerIframe.addEventListener('mozbrowserloadend', function() {
    console.harness('!! load end');
    win = gRunnerWindow = runnerIframe.contentWindow;
    win.addEventListener('error', errorListener);
    win.addEventListener('message', logListener);
  });

  runnerIframe.setAttribute(
    'src', baseUrl + 'test/loggest-runner.html?' + buildQuery(passToRunner));
  console.harness('src set to:', runnerIframe.getAttribute('src'));

  console.harness('about to append');
  document.documentElement.appendChild(runnerIframe);


  return deferred.promise;
}

function writeTestLog(testFileName, variant, jsonStr, summary) {
  try {
    var encoder = new TextEncoder('utf-8');
    var logFilename = testFileName + '-' +
                      variant.replace(/:/g, '_') + '.log';
    summary._filename = logFilename;
    var logPath = do_get_file('test-logs').path +
                  '/' + logFilename;
    console.harness('writing to', logPath);
    var str;
    // If we know the output is for Travis, don't put in the detector blocks,
    // just generate raw JSON.
    if (TEST_PARAMS.printTravisUrls) {
      str = jsonStr;
    }
    else {
      str = '##### LOGGEST-TEST-RUN-BEGIN #####\n' +
            jsonStr + '\n' +
            '##### LOGGEST-TEST-RUN-END #####\n';
    }
    var arr = encoder.encode(str);
    return OS.File.writeAtomic(logPath, arr, { tmpPath: logPath + '.tmp' });
  }
  catch (ex) {
    console.error('Error trying to write log to disk!', ex, '\n', ex.stack);
    return null;
  }
}

function writeFile(dirPath, filename, str) {
  try {
    var encoder = new TextEncoder('utf-8');
    var logPath = do_get_file(dirPath).path +
                  '/' + filename;
    var arr = encoder.encode(str);
    return OS.File.writeAtomic(logPath, arr, { tmpPath: logPath + '.tmp' });
  }
  catch (ex) {
    console.error('Error trying to write file to disk!', ex, '\n', ex.stack);
    return null;
  }
}


/**
 * Run one or more tests.
 */
function runTests(configData) {
  var deferred = defer();

  var summaries = [];

  var useVariants = [];
  if (TEST_VARIANT) {
    useVariants.push(TEST_VARIANT);
  } else {
    for (var variantName in configData.variants) {
      var variantData = configData.variants[variantName];
      if (!variantData.optional ||
          (variantName === 'imap:real' && TEST_PARAMS.type === 'imap') ||
          (variantName === 'activesync:real' &&
           TEST_PARAMS.type === 'activesync')) {
        useVariants.push(variantName);
      }
    }
  }
  console.log('legal variants for tests:', useVariants);

  var controlServer = FakeServerSupport.makeControlHttpServer().server;

  var runTests = [];
  for (var testName in configData.tests) {
    var testData = configData.tests[testName];
    var testVariants = testData.variants.filter(function(v) {
                        return useVariants.indexOf(v) !== -1;
                       });
    if (testVariants.length) {
      runTests.push(
        {
          name: testName.replace(/\.js$/, ''),
          // filter out the variants that we don't want to run right now
          variants: testVariants,
        });
      console.log('planning to run test:', testName);
    }
  }

  if (runTests.length === 0) {
    console.warn('0 tests matched; are you sure that you added the file to',
                 TEST_CONFIG, 'and that one of its supported variants is',
                'listed above?');
  }

  var iTest = 0, iVariant = 0, curTestInfo = null;
  function runNextTest(summary) {
    if (summary)
      summaries.push(summary);

    if (curTestInfo && iVariant >= curTestInfo.variants.length) {
      iTest++;
      iVariant = 0;
    }
    if (iTest >= runTests.length) {
      controlServer.shutdown();
      deferred.resolve(summaries);
      return;
    }

    curTestInfo = runTests[iTest];

    runTestFile(curTestInfo.name, curTestInfo.variants[iVariant++],
                controlServer)
      .then(runNextTest,
            function(err) { console.error('Problem running test:', err); });
  }
  runNextTest();

  return deferred.promise;
}

function DOMLoaded() {
  OS.File.read(TEST_CONFIG).then(function(dataArr) {
    var decoder = new TextDecoder('utf-8');
    try {
      var configData = JSON.parse(decoder.decode(dataArr));
    }
    catch (ex) {
      console.error('Problem with JSON config file:', ex);
    }

    if (TEST_COMMAND) {
      console.log('got command:', TEST_COMMAND);
      switch (TEST_COMMAND) {
        case 'imap-fake-server':
          try {
            window.imapServer = FakeServerSupport.makeIMAPServer(
              { username: 'testy', password: 'testy' });
          }
          catch (ex) {
            console.error('Problem spinning up IMAP server', ex, '\n',
                          ex.stack);
          }
          try {
            window.smtpServer = FakeServerSupport.makeSMTPServer(
              { username: 'testy', password: 'testy' });
          }
          catch (ex) {
            console.error('Problem spinning up SMTP server', ex, '\n',
                          ex.stack);
          }

          console.log('IMAP server up on port', window.imapServer.port);
          console.log('SMTP server up on port', window.smtpServer.port);
          break;

        case 'activesync-fake-server':
          try {
            window.activesyncServer = FakeServerSupport.makeActiveSyncServer(
              { username: 'testy', password: 'testy' });
          }
          catch (ex) {
            console.error('Problem spinning up ActiveSync server', ex, '\n',
                          ex.stack);
          }
          console.log('ActiveSync server up on port',
                      window.activesyncServer.port);
          break;
      }
      return;
    }

    // If there's a TEST_NAME, we use it to filter the list of tests to things
    // that have a substring match.  So if a full filename is provided, we
    // should still correctly only run that file.
    if (TEST_NAME) {
      var lowerCheck = TEST_NAME.toLowerCase();
      var keepTests = {};
      for (var testName in configData.tests) {
        if (testName.toLowerCase().indexOf(lowerCheck) !== -1) {
          keepTests[testName] = configData.tests[testName];
        }
      }
      configData.tests = keepTests;
    }
    try {
      runTests(configData).then(function(summaries) {
        dump('\n\n***** ' + summaries.length + ' tests run: *****\n\n');
        summaries.forEach(function(summary) {
          printTestSummary(summary);
        });
        dump('\n************************\n\n');

        var testResult = getTestResult(summaries);
        var jsonString = JSON.stringify({ result: testResult });

        writeFile('test-logs', 'test-run.summary', jsonString).then(function() {
          quitApp();
        });
      });
    }
    catch (ex) {
      console.error('runTests explosion:', ex, '\n', ex.stack);
    }
  });

}

} catch (ex) {
  dump('loggest-chrome-runner serious error: ' + ex + '\n' + ex.stack + '\n');
}
