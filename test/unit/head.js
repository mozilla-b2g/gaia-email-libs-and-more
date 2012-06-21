const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;
const CC = Components.Constructor;

function consoleHelper() {
  var msg = arguments[0] + ":";
  for (var i = 1; i < arguments.length; i++) {
    msg += " " + arguments[i];
  }
  msg += "\x1b[0m";
  print(msg);
}
var console = {
  log:   consoleHelper.bind(null, '\x1b[32mLOG'),
  error: consoleHelper.bind(null, '\x1b[31mERR'),
  info:  consoleHelper.bind(null, '\x1b[36mINF'),
  warn:  consoleHelper.bind(null, '\x1b[33mWAR'),
  trace: function() {
    console.error.apply(null, arguments);
    try {
      throw new Error('getting stack...');
    }
    catch (ex) {
      console.warn('STACK!\n' + ex.stack);
    }
  },
};


// We want a profile because we will be loading IndexedDB
do_get_profile();
// And the IndexedDB unit tests claim that some horrible threading thing happens
// if we aren't sure to trigger this lookup from the main thread to bootstrap
// things...
var dirSvc = Cc["@mozilla.org/file/directory_service;1"]
               .getService(Ci.nsIProperties);
var file = dirSvc.get("ProfD", Ci.nsIFile);

const nsIScriptError = Ci.nsIScriptError;
var ErrorTrapper = {
  _trappedErrors: null,
  _handlerCallback: null,
  /**
   * Express interest in errors.
   */
  trapErrors: function() {
    this._trappedErrors = [];
  },
  callbackOnError: function(handler) {
    this._handlerCallback = handler;
    this._trappedErrors = [];
  },
  yoAnError: function(err, moduleName) {
    if (this._trappedErrors == null || SUPER_DEBUG) {
      console.error("==== REQUIREJS ERR ====", moduleName);
      console.error(err.message);
      console.error(err.stack);
      if (DEATH_PRONE) {
        console.error("PERFORMING PROCESS EXIT");
        process.exit(1);
      }
    }
    if (this._handlerCallback)
      this._handlerCallback(err, moduleName);
    else if (this._trappedErrors)
      this._trappedErrors.push(err);
  },
  gobbleAndStopTrappingErrors: function() {
    this._handlerCallback = null;
    var errs = this._trappedErrors;
    this._trappedErrors = null;
    return errs;
  },

  _listenerMap: {
    exit: null,
    uncaughtException: null,
  },
  on: function(name, listener) {
    this._listenerMap[name] = listener;
  },
  once: function(name, listener) {
    this._listenerMap[name] = function(data) {
      listener(data);
      ErrorTrapper.removeListener(name);
    };
  },
  removeListener: function(name) {
    this._listenerMap[name] = null;
  },
  reliableOutput: print,

  fire: function(name, data) {
    if (!this._listenerMap[name])
      return;
    console.log('firing', name, data);
    this._listenerMap[name](data);
  },

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

        this.fire('uncaughtException',
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
    } catch (ex) {
      print("SELF-SPLOSION: " + ex + "\n");
    }
  },

  hookConsoleService: function() {
    this.consoleService = Cc["@mozilla.org/consoleservice;1"]
                            .getService(Ci.nsIConsoleService);
    this.consoleService.registerListener(this);

    // we need to unregister our listener at shutdown if we don't want explosions
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
do_register_cleanup(function() {
  ErrorTrapper.fire('exit', null);
});
ErrorTrapper.hookConsoleService();

// Look enough like a window for all of our tests (IndexedDB, empty navigator/document)
load('resources/window_shims.js');
// Expose B2G magic window globals that we want/care about.
load('resources/b2g_shims.js');
// Load RequireJS and make it capable of loading things in xpcshell
load('resources/require.js');
load('resources/requirejs_shim.js');

// Configure RequireJS for our super-cool mapping of super-cool-ness.
require({
  catchError: {
    define: true,
  },
  baseUrl: '../..',
  paths: {
    // NOP's
    "http": "data/lib/nop",
    "https": "data/lib/nop2",
    "url": "data/lib/nop3",
    "fs": "data/lib/nop4",
    "child_process": "data/lib/nop5",

    "q": "data/lib/q",
    "text": "data/lib/text",
    // silly shim
    "event-queue": "data/lib/js-shims/event-queue",
    "microtime": "data/lib/js-shims/microtime",
    "path": "data/lib/js-shims/path",

    "imap": "data/lib/imap",

    "rdplat": "data/lib/rdplat",
    "rdcommon": "data/lib/rdcommon",
    "rdimap": "data/lib/rdimap",

    "buffer": "data/lib/node-buffer",
    "crypto": "data/lib/node-crypto",
    "net": "data/lib/node-net",
    "tls": "data/lib/node-tls",
    "os": "data/lib/node-os",
    "timers": "data/lib/node-timers",

    "iconv": "data/lib/js-shims/faux-iconv",

    "assert": "data/deps/browserify-builtins/assert",
    "events": "data/deps/browserify-builtins/events",
    "stream": "data/deps/browserify-builtins/stream",
    "util": "data/deps/browserify-builtins/util",

    // These used to be packages but we have AMD shims for their mains where
    // appropriate, so we can just use paths.
    "mimelib": "data/deps/mimelib",
    "mailparser": "data/deps/mailparser/lib",
    "simplesmtp": "data/deps/simplesmtp",
    "mailcomposer": "data/deps/mailcomposer",
  },
});

load('../../deps/stringencoding/encoding-indexes.js');
load('../../deps/stringencoding/encoding.js');
var Buffer = window.Buffer = require('buffer').Buffer;
// brief node shims... a-la shim-sham.js
var process = window.process = {
  immediate: false,
  nextTick: function(cb) {
    if (this.immediate)
      cb();
    else
      window.setZeroTimeout(cb);
  },
};


// -- Pull relevant test environment variables out of the environment.
// The goal is to allow our unit tests to be run against varying server
// configurations, etc.
const ENVIRON_MAPPINGS = [
  {
    name: 'emailAddress',
    envVar: 'GELAM_TEST_ACCOUNT',
  },
  {
    name: 'password',
    envVar: 'GELAM_TEST_PASSWORD',
  }
];
var TEST_PARAMS = {
  emailAddress: 'testy@localhost',
  password: 'testy',
};
var TEST_PARAMS_ARE_DEFAULTS = true;

function populateTestParams() {
  let environ = Cc["@mozilla.org/process/environment;1"]
                  .getService(Ci.nsIEnvironment);
  for each (let [, {name, envVar}] in Iterator(ENVIRON_MAPPINGS)) {
    if (environ.exists(envVar)) {
      TEST_PARAMS[name] = environ.get(envVar);
      TEST_PARAMS_ARE_DEFAULTS = false;
    }
  }
}
populateTestParams();
