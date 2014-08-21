/**
 * Worker bootstrapping for unit test purposes (for now).  Gets replaced with
 * a gaia appropriate file on install-into-gaia.  The contents of the path
 * map are currently identical to those in gelam-require-map.js.
 *
 * The key differences between this and the real bootstrapper are:
 * - our paths map is different; we don't use consolidated files (currently,
 *   probably a good idea to use them)
 * - we include paths for the unit test framework
 * - we load the unit-test driver
 **/
var window = self;
var testLogEnable = false;

var gelamWorkerBaseUrl = '../js';

importScripts('../js/ext/alameda.js');
importScripts('../js/worker-config.js');

requirejs.config({
  // This map config exists because mailapi is loaded in a worker for tests.
  // Normally for main-frame-setup use, mailapi references
  // './ext/addressparser', to avoid outside consumers of gelam from needing
  // any special config. However, this conflicts with the 'addressparser'
  // usage inside the worker. Since this concern is only for tests, it is not
  // the normal way gelam is consumed, this map config is set up just for the
  // tests.
  map: {
    'mailapi': {
      'ext/addressparser': 'addressparser'
    }
  },
  // For tests, time out in case there are non-404 errors.
  waitSeconds: 10
});

function makeConsoleFunc(prefix) {
  return function() {
    if (!this._enabled)
      return;
    var msg = prefix + ':';
    for (var i = 0; i < arguments.length; i++) {
      msg += ' ' + arguments[i];
    }
    msg += '\x1b[0m\n';
    dump(msg);
  };
}

window.console = {
  _enabled: false,
  log: makeConsoleFunc('\x1b[32mWLOG'),
  error: makeConsoleFunc('\x1b[31mWERR'),
  info: makeConsoleFunc('\x1b[36mWINF'),
  warn: makeConsoleFunc('\x1b[33mWWAR'),
};

window.navigator.mozContacts = {
  find: function(opts) {
    var req = { onsuccess: null, onerror: null, result: null };
    window.setZeroTimeout(function() {
      if (req.onsuccess)
        req.onsuccess({ target: req });
    });
    return req;
  },
};

var document = { cookie: null };

// Configure path for the test directory, relative to gelamWorkerBaseUrl
require.config({
  paths: {
    test: '../test',
    gelam: '.'
  }
});

require(['test/loggest-runner-worker']);
