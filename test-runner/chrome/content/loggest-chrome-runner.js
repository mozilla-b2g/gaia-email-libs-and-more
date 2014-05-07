/**
 * Minimal test running framework.
 *
 * We:
 * - turn off things that might needlessly mess with the test
 * - use a test runner that can be run from content / anywhere
 * - augment the error reporting capabilities of the test runner by listening to
 *   the console service and friends
 * - use a custom protocol so we get a distinct origin per test file
 * - ensure permissions are set for our custom origin
 * - make sure devicestorage uses our profile directory rather than randomly
 *   touching the FS.
 * - write the test log
 *
 * This file is currently a little soupy; various logic is all mixed in here.
 **/
try {

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;
const CC = Components.Constructor;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

Cu.import("resource://gre/modules/osfile.jsm");

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

const nsIScriptError = Ci.nsIScriptError;

var gRunnerWindow;

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
      if (!/can't access dead object/.test(ex.message)) {
        dump("SELF-SPLOSION: " + ex + "\n" + ex.stack + "\n");
      }
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
register_resource_alias('activesync', do_get_file('deps/activesync'));

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

const STATE_START = Ci.nsIWebProgressListener.STATE_START,
      STATE_REDIRECTING = Ci.nsIWebProgressListener.STATE_REDIRECTING,
      STATE_TRANSFERRING = Ci.nsIWebProgressListener.STATE_TRANSFERRING,
      STATE_NEGOTIATING = Ci.nsIWebProgressListener.STATE_NEGOTIATING,
      STATE_STOP = Ci.nsIWebProgressListener.STATE_STOP,
      STATE_IS_REQUEST = Ci.nsIWebProgressListener.STATE_IS_REQUEST,
      STATE_IS_DOCUMENT = Ci.nsIWebProgressListener.STATE_IS_DOCUMENT,
      STATE_IS_NETWORK = Ci.nsIWebProgressListener.STATE_IS_NETWORK,
      STATE_IS_WINDOW = Ci.nsIWebProgressListener.STATE_IS_WINDOW;

function ProgressListener(opts) {
  this._callOnStart = opts.onStart;
  this._callOnLoaded = opts.onLoaded;
}
ProgressListener.prototype = {
  onLocationChange: function(aWebProgress) {
    console.harness('location change!');
  },
  onProgressChange: function(aWebProgress) {
    console.harness('progress change!');
  },
  onSecurityChange: function(aWebProgress) {
    console.harness('security change!');
  },
  onStateChange: function(aWebProgress, aRequest, aStateFlags, aStatus) {
    try {
      var flags = [];

      if (aStateFlags & STATE_START)
        flags.push('start');
      if (aStateFlags & STATE_REDIRECTING)
        flags.push('redirecting');
      if (aStateFlags & STATE_TRANSFERRING)
        flags.push('transferring');
      if (aStateFlags & STATE_NEGOTIATING)
        flags.push('negotiating');
      if (aStateFlags & STATE_STOP)
        flags.push('stop');

      if (aStateFlags & STATE_IS_REQUEST)
        flags.push('is-request');
      if (aStateFlags & STATE_IS_DOCUMENT)
        flags.push('is-document');
      if (aStateFlags & STATE_IS_NETWORK)
        flags.push('is-network');
      if (aStateFlags & STATE_IS_WINDOW)
        flags.push('is-window');

      console.harness('progress:', aStateFlags, flags, '-', aStatus, 'on',
                      aRequest && aRequest.name);

      // We don't exist to listen to about:blank changes.  We only care about
      // the actual thang.
      if (aRequest.name == 'about:blank') {
        console.harness('  (ignoring about:blank event)');
        return;
      }

      if (aStateFlags & STATE_START && aStateFlags & STATE_IS_WINDOW &&
          this._callOnStart)
        this._callOnStart();
      //console.log('state change', aStateFlags);
      if (aStateFlags & STATE_STOP && aStateFlags & STATE_IS_WINDOW &&
          this._callOnLoaded)
        this._callOnLoaded();
    }
    catch(ex) {
      console.error('Problem in stateChange callback:', ex, '\n', ex.stack);
    }
  },
  onStatusChange: function() {
    console.harness('status change!');
  },

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIWebProgressListener,
                                         Ci.nsISupportsWeakReference]),
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

/**
 * Pull test name and arguments out of command-line and/or environment
 */
function populateTestParams() {
  let args = window.arguments[0].QueryInterface(Ci.nsICommandLine);

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
// We want any device storage tests to stick inside our test sub-directory and
// not be affected by our affect anywhere else on the disk.
//
// See the constants in:
// http://mxr.mozilla.org/mozilla-central/source/xpcom/io/nsDirectoryServiceDefs.h#54
// and their usages in nsDeviceStorage.cpp
//
// Note that DeviceStorage does support a "device.storage.testing" pref, but
// then it just makes a subdirectory of the temp directory, which limits
// our ability to test orthogonal device storages, etc.

var dirService = Cc["@mozilla.org/file/directory_service;1"]
                   .getService(Ci.nsIProperties);
var DEVICE_STORAGE_PATH_CLOBBERINGS = {
  // Linux:
  'XDGPict': 'pictures',
  'XDGMusic': 'music',
  'XDGVids': 'videos',
  // OSX:
  'Pct': 'pictures',
  'Music': 'music',
  'Mov': 'videos',
  // Win:
  'Pict': 'pictures',
  'Music': 'music',
  'Vids': 'videos'
};

  /*
let replacementDirServiceProvider = {
  getFile: function(prop, persistent) {
    persistent.value = true;
    if (DEVICE_STORAGE_PATH_CLOBBERINGS.hasOwnProperty(prop))
      return deviceStorageFile.clone();

    return dirService.getFile(prop, persistent);
  },
  'get': function(prop, iid) {
    return dirService.get(prop, iid);
  },
  'set': function(prop, value) {
    return dirService.set(prop, value);
  },
  'has': function(prop) {

  },
  QueryInterface: XPCOMUtils.generateQI(
                    [Ci.nsIDirectoryService, Ci.nsIProperties]),
};
Components.manager
  .QueryInterface(Ci.nsIComponentRegistrar)
  .registerFactory(Components.ID('{753e01a4-dc3c-48c7-b45e-91544ec01302}'),
                   'fake directory service',
                   '@mozilla.org/file/directory_service;1',
                   replacementDirServiceProvider);
*/


function makeAndSetDeviceStorageTarget(subdirName) {
  var deviceStorageFile = dirService.get('ProfD', Ci.nsIFile);
  deviceStorageFile.append('device-storage');
  deviceStorageFile.append(subdirName);

  deviceStorageFile.create(Ci.nsIFile.DIRECTORY_TYPE, parseInt('777', 8));

  for (let name in DEVICE_STORAGE_PATH_CLOBBERINGS) {
    // force an undefine
    try {
      dirService.undefine(name);
    }
    catch(ex) {}
    dirService.set(name, deviceStorageFile);
    //console.log('after', name, dirService.get(name, Ci.nsILocalFile).path);
  }
}

////////////////////////////////////////////////////////////////////////////////
// permissions
//
// This has to be handled in 2 ways:
// - add the actual permissions to the old-school permissions manager
// - properly be handled by ContentPermissionPrompt..
//   b2g/components/ContentPermissionPrompt.js assumes that everything either
//   has the system principal or is an app.

// copied from our webapp.manifest
var EMAIL_PERMISSIONS = {
    "alarms":{},
    "audio-channel-notification":{},
    "contacts":{ "access": "readcreate" },
    "desktop-notification":{},
    "device-storage:sdcard":{ "access": "readcreate" },
    "systemXHR":{},
    "settings":{ "access": "readonly" },
    "tcp-socket":{}
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

componentRegistrar.registerFactory(
  Components.ID("{d56fec31-dc7a-4526-9e12-a722f3effb3b}"),
  "Fake Content Permission Prompt Service",
  "@mozilla.org/content-permission/prompt;1",
  FakeContentPermissionPrompt);

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
 * For time/simplicity reasons, we aren't actually doing any type of async
 * proxying here but are instead favoring a synchronous API we are able to
 * expose directly into the content space.
 *
 * In a fancy async implementation, TestActiveSyncServerMixins could be made to
 * generate expectations to cover any async behaviour we started exhibiting.
 */
function ActiveSyncServerProxy() {
  this.server = null;

}
ActiveSyncServerProxy.prototype = {
  __exposedProps__: {
    createServer: 'r',
    addFolder: 'r',
    addMessageToFolder: 'r',
    addMessagesToFolder: 'r',
    useLoggers: 'r',
  },

  createServer: function(useDate) {
    this.server = new ActiveSyncServer(useDate);
    this.server.start(0);

    var httpServer = this.server.server,
        port = httpServer._socket.port;

    httpServer._port = port;
    // it had created the identity on port 0, which is not helpful to anyone
    httpServer._identity._initialize(port, httpServer._host, true);

    return {
      id: 'only',
      port: port
    };
  },

  addFolder: function(serverHandle, name, type, parentId, messageSetDef) {
    var folder = this.server.addFolder(name, type, parentId, messageSetDef);
    return folder.id;
  },

  addMessageToFolder: function(serverHandle, folderId, messageDef) {
    var folder = this.server.foldersById[folderId];
    folder.addMessage(messageDef);
  },

  addMessagesToFolder: function(serverHandle, folderId, messageSetDef) {
    var folder = this.server.foldersById[folderId];

  },

  useLoggers: function(serverHandle, loggers) {
    this.server.logRequest = loggers.request || null;
    this.server.logRequestBody = loggers.requestBody || null;
    this.server.logResponse = loggers.response || null;
    this.server.logResponseError  = loggers.responseError || null;
  },

  killServer: function() {
    if (!this.server)
      return;
    try {
      this.server.stop();
    }
    catch (ex) {
      console.error('Problem shutting down ActiveSync server:\n',
                    ex, '\n', ex.stack);
    }
    this.server = null;
  },

  cleanup: function() {
    this.killServer();
  }
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
 * @param controlServer The ControlServer to point the test at.
 */
function runTestFile(testFileName, variant, controlServer) {
  try {
    return _runTestFile(testFileName, variant, controlServer);
  }
  catch(ex) {
    console.error('Error in runTestFile', ex, '\n', ex.stack);
    throw ex;
  }
};
function _runTestFile(testFileName, variant, controlServer) {
  console.harness('running', testFileName, 'variant', variant);

  // Parameters to pass into the test.
  var testParams;
  switch (variant) {
    case 'imap:fake':
      testParams = {
        name: 'Baron von Testendude',
        emailAddress: 'testy@fakeimaphost',
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

  // Our testfile protocol allows us to use the test file as an origin, so every
  // test file gets its own instance of the e-mail database.  This is better
  // than deleting the database every time because at the end of the run we
  // will have all the untouched IndexedDB databases around so we can poke at
  // them if we need/want.
  var baseUrl = 'testfile://' + testFileName + '-' +
                  variant.replace(/:/g, '_') + '/';
  grantEmailPermissions(baseUrl);

  var runnerIframe = gIframe = document.createElement('iframe');
  runnerIframe.setAttribute('type', 'content');
  runnerIframe.setAttribute('flex', '1');
  runnerIframe.setAttribute('style', 'border: 1px solid blue;');

  var win, domWin;

  var deferred = defer();

  var cleanupList = [];
  if (controlServer)
    cleanupList.push(controlServer);

  function cleanupWindow() {
    try {
      runnerIframe.parentNode.removeChild(runnerIframe);

      cleanupList.forEach(function(obj) {
        obj.cleanup();
      });
    }
    catch(ex) {
      console.harness('Problem cleaning up window', ex, '\n', ex.stack);
    }
  }

  // XXX so, I'm having trouble with the web progress listener not being
  // reliable in certain cases that have to do with async event ordering.
  // So as a hack I'm just putting the fake parent object on early, even
  // though it might get nuked off in most cases and require our progress
  // listener to put it back on.
  var processedLog = false;
  var fakeParentObj = {
      __exposedProps__: {
        fakeParent: 'r',
        postMessage: 'r',
      },
      fakeParent: true,
      postMessage: function(data, dest) {
        if (processedLog) {
          console.harness('WARNING: Already got a processed log!');
          return;
        }
        processedLog = true;

console.harness('calling writeTestLog and resolving');
        var jsonStr = data.data,
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
      }
    };

  // we want to make sure that we only poke things into the window once it
  // exists
  var progressListenFlags = Ci.nsIWebProgress.NOTIFY_STATE_WINDOW |
                            Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT |
                            Ci.nsIWebProgress.NOTIFY_STATE_NETWORK |
                            Ci.nsIWebProgress.NOTIFY_STATE_REQUEST;
  var progressListener = gProgress = new ProgressListener({
    onLoaded: function() {
      console.harness('page started; poking functionality inside');
      win = gRunnerWindow = runnerIframe.contentWindow;
      win.addEventListener('error', errorListener);
      domWin = win.wrappedJSObject;

      webProgress.removeProgressListener(progressListener,
                                         progressListenFlags);

      // Look like we are content-space that embedded the iframe!
      domWin.parent = fakeParentObj;

      // We somehow did not initialize before the report, just use the log
      // from there.
      if (domWin.logResultsMsg) {
        domWin.parent.postMessage(domWin.logResultsMsg, '*');
      }

      console.log('domWin.parent.fakeParent', domWin.parent.fakeParent);

      // XXX ugly magic bridge to allow creation of/control of fake ActiveSync
      // servers.
      var asProxy = new ActiveSyncServerProxy();
      domWin.MAGIC_SERVER_CONTROL = asProxy;
      cleanupList.push(asProxy);
    }});


  console.harness('about to append');
  document.documentElement.appendChild(runnerIframe);

  var webProgress = runnerIframe.webNavigation
                      .QueryInterface(Ci.nsIWebProgress);
  webProgress.addProgressListener(progressListener, progressListenFlags);

  console.harness('about to set src');
  runnerIframe.setAttribute(
    'src', baseUrl + 'test/loggest-runner.html?' + buildQuery(passToRunner));
  console.harness('src set to:', runnerIframe.getAttribute('src'));

  var errorListener = function errorListener(errorMsg, url, lineNumber) {
    console.harness('win err:', errorMsg, url, lineNumber);
  };

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
      .then(runNextTest);
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
