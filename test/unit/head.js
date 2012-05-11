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
};


// We want a profile because we will be loading IndexedDB
do_get_profile();
// And the IndexedDB unit tests claim that some horrible threading thing happens
// if we aren't sure to trigger this lookup from the main thread to bootstrap
// things...
var dirSvc = Cc["@mozilla.org/file/directory_service;1"]
               .getService(Ci.nsIProperties);
var file = dirSvc.get("ProfD", Ci.nsIFile);

// Look enough like a window for all of our tests (IndexedDB, empty navigator/document)
load('resources/window_shims.js');
// Expose B2G magic window globals that we want/care about.
load('resources/b2g_shims.js');
// Load RequireJS and make it capable of loading things in xpcshell
load('resources/require.js');
load('resources/requirejs_shim.js');

// Configure RequireJS for our super-cool mapping of super-cool-ness.
require({
  baseUrl: '../..',
  paths: {
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

    "iconv": "data/lib/js-shims/faux-iconv",
    "iconv-lite": "data/libs/js-shims/faux-iconx",

    "assert": "data/deps/browserify-builtins/assert",
    "events": "data/deps/browserify-builtins/events",
    "stream": "data/deps/browserify-builtins/stream",
    "util": "data/deps/browserify-builtins/util",

    // These used to be packages but we have AMD shims for their mains where
    // appropriate, so we can just use paths.
    "mimelib": "data/deps/mimelib",
    "mailparser": "data/deps/mailparser/lib",
    "simplesmtp": "data/deps/simplesmtp",
  },
});

load('../../deps/stringencoding/encoding.js');
var Buffer = window.Buffer = require('buffer').Buffer;
// brief node shims... a-la shim-sham.js
var process = window.process = {
  immediate: false,
  nextTick: function(cb) {
    if (this.immediate)
      cb();
    else
      do_execute_soon(cb);
  },
};
