/**
 * Minimal test running framework.
 *
 * We:
 * - turn off things that might needlessly mess with the test
 * - use a test runner that can be run from content anywhere
 * - augment the error reporting capabilities of the test runner by listening to
 *   the console service and friends
 * - write the test log
 **/
try {

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;
const CC = Components.Constructor;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/commonjs/promise/core.js");
Cu.import("resource://gre/modules/osfile.jsm");

////////////////////////////////////////////////////////////////////////////////
// have all console.log usages in this file be pretty to dump()

Services.prefs.setBoolPref('browser.dom.window.dump.enabled', true);

function consoleHelper() {
  var msg = arguments[0] + ':';
  for (var i = 1; i < arguments.length; i++) {
    msg += ' ' + arguments[i];
  }
  msg += '\x1b[0m\n';
  dump(msg);
}
window.console = {
  log: consoleHelper.bind(null, '\x1b[32mLOG'),
  error: consoleHelper.bind(null, '\x1b[31mERR'),
  info: consoleHelper.bind(null, '\x1b[36mINF'),
  warn: consoleHelper.bind(null, '\x1b[33mWAR')
};

console.log('Initial loggest-chrome-runner.js bootstrap begun');

////////////////////////////////////////////////////////////////////////////////
// Error handling support; call directly into the page's ErrorTrapper

const nsIScriptError = Ci.nsIScriptError;

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

        if (gRunnerWindow && gRunnerWindow.ErrorTrapper) {
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
      dump("SELF-SPLOSION: " + ex + "\n");
    }
  },

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
      // Not using do_throw(): caller will continue.
      _passed = false;
      var stack = Components.stack.caller;
      _dump("TEST-UNEXPECTED-FAIL | " + stack.filename + " | [" +
            stack.name + " : " + stack.lineNumber + "] " + lf.path +
            " does not exist\n");
    }

    return lf;
  }
  catch (ex) {
    do_throw(ex.toString(), Components.stack.caller);
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
    console.log('adding resources alias:', alias, 'to', dirURI.path);
    protocolHandler.setSubstitution(alias, dirURI);
  };
}

////////////////////////////////////////////////////////////////////////////////
// mailnews useful logic

// from alertTestUtils.js:
var alertUtilsPromptService = {
  alert: function(aParent, aDialogTitle, aText) {
    dump("ALERT: " + aText + "\n");
    return;
  },

  alertCheck: function(aParent, aDialogTitle, aText, aCheckMsg, aCheckState) {
    dump("ALERTCHECK: " + aText + "\n");
    return;
  },

  confirm: function(aParent, aDialogTitle, aText) {
    dump("CONFIRM: " + aText + "\n");
    return false;
  },

  confirmCheck: function(aParent, aDialogTitle, aText, aCheckMsg, aCheckState) {
    dump("CONFIRMCHECK: " + aText + "\n");
    return false;
  },

  confirmEx: function(aParent, aDialogTitle, aText, aButtonFlags, aButton0Title,
                      aButton1Title, aButton2Title, aCheckMsg, aCheckState) {
    dump("CONFIRMEX: " + aText + "\n");
    return 0;
  },

  prompt: function(aParent, aDialogTitle, aText, aValue, aCheckMsg,
                   aCheckState) {
    dump("PROMPT: " + aText + "\n");
    return false;
  },

  promptUsernameAndPassword: function(aParent, aDialogTitle, aText, aUsername,
                                      aPassword, aCheckMsg, aCheckState) {
    dump("PROMPTUSERPW: " + aText + "\n");
    return false;
  },

  promptPassword: function(aParent, aDialogTitle, aText, aPassword, aCheckMsg,
                           aCheckState) {
    dump("PROMPTPW: " + aText + "\n");
    return false;
  },

  select: function(aParent, aDialogTitle, aText, aCount, aSelectList,
                   aOutSelection) {
    dump("SELECT: " + aText + "\n");
    return false;
  },

  createInstance: function createInstance(outer, iid) {
    if (outer != null)
      throw Components.results.NS_ERROR_NO_AGGREGATION;
    return this.QueryInterface(iid);
  },

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIPromptService,
                                         Ci.nsIPromptService2])
};

function registerAlertTestUtils()
{
  Components.manager.QueryInterface(Components.interfaces.nsIComponentRegistrar)
            .registerFactory(Components.ID("{4637b567-6e2d-4a24-9775-e8fc0fb159ba}"),
                             "Fake Prompt Service",
                             "@mozilla.org/embedcomp/prompt-service;1",
                             alertUtilsPromptService);
}

//registerAlertTestUtils();

////////////////////////////////////////////////////////////////////////////////
// custom protocol stuff from :gozala's protocol implementation




////////////////////////////////////////////////////////////////////////////////
// stuff from xpcshell-type context; probably remove

const STATE_STOP = Ci.nsIWebProgressListener.STATE_STOP,
      STATE_IS_WINDOW = Ci.nsIWebProgressListener.STATE_IS_WINDOW;

function ProgressListener(tds) {
}
ProgressListener.prototype = {
  onLocationChange: function() {
    console.log('location change!');
  },
  onProgressChange: function() {
    console.log('progress change!');
  },
  onSecurityChange: function() {
    console.log('security change!');
  },
  onStateChange: function(aWebProgress, aRequest, aStateFlags, aStatus) {
    console.log('state change', aStateFlags);
  },
  onStatusChange: function() {
    console.log('status change!');
  },

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIWebProgressListener,
                                         Ci.nsISupportsWeakReference]),
};

function TestDocshell(testfile) {
  this.docshell = Cc["@mozilla.org/docshell;1"].createInstance(Ci.nsIDocShell);
  this.webnav = this.docshell.QueryInterface(Ci.nsIWebNavigation);
  this.webprogress = this.webnav.QueryInterface(Ci.nsIWebProgress);
  this.doc = null;
  this.win = null;

  this.webprogress.addProgressListener(new ProgressListener(this),
                                       Ci.nsIWebProgress.NOTIFY_STATE_WINDOW);
/*
  this.win.addEventListener('DOMContentLoaded', function() {
    console.log('URL loaded!');
  });
 */

  this.testRunnerUrl = 'resource://gelam/test/loggest-runner.html';
  this.testUrl = 'resource://gelam/test/unit/' + testfile;

  var IWebNav = Ci.nsIWebNavigation;
  this.webnav.loadURI(this.testRunnerUrl,
                      IWebNav.LOAD_FLAGS_BYPASS_HISTORY |
                        IWebNav.LOAD_FLAGS_BYPASS_CACHE |
                        IWebNav.LOAD_FLAGS_BYPASS_CLASSIFIER,
                      null, null, null);
/*
  do_timeout(1000, function() {
    this.win = this.docshell.QueryInterface(Ci.nsIInterfaceRequestor)
                 .getInterface(Ci.nsIDOMWindow);
    console.log('this.win', this.win);
    console.log('URI after load:', this.webnav.currentURI.spec);
  }.bind(this));
 */
}
TestDocshell.prototype = {
  _loaded: function() {
    console.log('load completed!');
    this.doc = this.webnav.document;
    console.log('doc:', this.doc);
    this.win = this.doc.defaultView;
    console.log('win:', this.win);

    try {
      console.log('web progress domwindow:', this.webprogress.DOMWindow);
    }
    catch (ex) {
      console.warn('there was no window!');
    }
  }
};


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
const ENVIRON_MAPPINGS = [
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
  {
    name: 'type',
    envVar: 'GELAM_TEST_ACCOUNT_TYPE',
    coerce: function (x) { return x; },
  },
  {
    name: 'slow',
    envVar: 'GELAM_TEST_ACCOUNT_SLOW',
    coerce: Boolean
  }
];
var TEST_PARAMS = {
  name: 'Baron von Testendude',
  emailAddress: 'testy@localhost',
  password: 'testy',
  slow: false,
  type: 'imap',

  defaultArgs: true
};

var TEST_NAME = null;
/**
 * Pull test name and arguments out of command-line and/or environment
 */
function populateTestParams() {
  let args = window.arguments[0].QueryInterface(Ci.nsICommandLine);

  TEST_NAME = args.handleFlagWithParam('test-name', false);

  let environ = Cc["@mozilla.org/process/environment;1"]
                  .getService(Ci.nsIEnvironment);
  for each (let [, {name, envVar, coerce}] in Iterator(ENVIRON_MAPPINGS)) {
    let argval = args.handleFlagWithParam('test-param-' + name, false);
    if (argval) {
      TEST_PARAMS[name] = coerce(argval);
      console.log('command line:', name, TEST_PARAMS[name]);
      if (name !== 'type')
        TEST_PARAMS.defaultArgs = false;
    }
    else if (environ.exists(envVar)) {
      TEST_PARAMS[name] = coerce(environ.get(envVar));
      console.log('environment:', name, TEST_PARAMS[name]);
      if (name !== 'type')
        TEST_PARAMS.defaultArgs = false;
    }
  }
}
populateTestParams();

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


var gRunnerIframe,
    gRunnerWindow;

function runTestFile(testFileName) {
  console.log('running', testFileName);

  var passToRunner = {
    testName: testFileName,
    testParams: JSON.stringify(TEST_PARAMS)
  };

  gRunnerIframe.webNavigation.QueryInterface(Ci.nsIWebProgress)
    .addProgressListener(new ProgressListener(),
                         Ci.nsIWebProgress.NOTIFY_STATE_ALL);

  var baseUrl = 'testfile://' + testFileName + '/';
//  gRunnerIframe.setAttribute(
//    'src', baseUrl + 'test/loggest-runner.html' /*?' + buildQuery(passToRunner) */);
  console.log('src set to:', gRunnerIframe.getAttribute('src'));

  var win = gRunnerWindow = gRunnerIframe.contentWindow;

  win.addEventListener('DOMContentLoaded', function() {
    console.log('iframe claims load complete');
  });

  var deferred = Promise.defer();

  var resultListener = function resultListener(evt) {
    if (!evt.data || evt.data.type !== 'loggest-test-results')
      return;

    window.removeEventListener('message', resultListener);
    window.removeEventListener('error', errorListener);

    // we are done when the log writing is done!
    deferred.resolve(writeTestLog(testFileName, evt.data.data));
  };

  var errorListener = function errorListener(errorMsg, url, lineNumber) {
    console.error('win err:', errorMsg, url, lineNumber);
  };

  win.addEventListener('message', resultListener);
  win.addEventListener('error', errorListener);

  return deferred.promise;
}

function writeTestLog(testFileName, jsonnableObj) {
  var encoder = new TextEncoder();
  var logFilename = testFileName.replace(/\.js$/, '.log');
  var logPath = do_get_file('test-logs/' + TEST_PARAMS.type + '/' +
                            logFilename).path;
  var str = '##### LOGGEST-TEST-RUN-BEGIN #####\n' +
            JSON.stringify(jsonnableObj) + '\n' +
            '##### LOGGEST-TEST-RUN-END #####\n';
  var arr = encoder.encode(str);
  return OS.File.writeAtomic(logPath, arr, { tmpPath: logPath + '.tmp' });
}

function DOMLoaded() {
  gRunnerIframe = document.getElementById('runner');
  runTestFile(TEST_NAME).then(function() {
    quitApp();
  });
}

} catch (ex) {
  dump('loggest-chrome-runner serious error: ' + ex + '\n' + ex.stack + '\n');
}
