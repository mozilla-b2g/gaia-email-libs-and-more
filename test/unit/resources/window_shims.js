var idbManager = Cc["@mozilla.org/dom/indexeddb/manager;1"]
                   .getService(Ci.nsIIndexedDatabaseManager);
idbManager.initWindowless(this);


const DOMException = Ci.nsIDOMDOMException;
const IDBCursor = Ci.nsIIDBCursor;
const IDBTransaction = Ci.nsIIDBTransaction;
const IDBOpenDBRequest = Ci.nsIIDBOpenDBRequest;
const IDBVersionChangeEvent = Ci.nsIIDBVersionChangeEvent;
const IDBDatabase = Ci.nsIIDBDatabase;
const IDBFactory = Ci.nsIIDBFactory;
const IDBIndex = Ci.nsIIDBIndex;
const IDBObjectStore = Ci.nsIIDBObjectStore;
const IDBRequest = Ci.nsIIDBRequest;

function setTimeout(func, delay) {
  var canceled = false;
  do_timeout(delay, function() {
    if (!canceled)
      func();
  });
  return function canceler() {
    canceled = true;
  };
}
function clearTimeout(handle) {
  if (handle)
    handle();
}

var moduleGlobalsHack = {};
Components.utils.import("resource://test/resources/globalshack.jsm",
                        moduleGlobalsHack);

/**
 * A function that can be clobbered to generate events when blob-related
 * things happen.
 */
var __blobLogFunc = function() {
};

var _window_mixin = {
  // - indexed db
  indexedDB: indexedDB,
  DOMException: DOMException,
  IDBCursor: IDBCursor,
  IDBTransaction: IDBTransaction,
  IDBOpenDBRequest: IDBOpenDBRequest,
  IDBVersionChangeEvent: IDBVersionChangeEvent,
  IDBDatabase: IDBDatabase,
  IDBFactory: IDBFactory,
  IDBIndex: IDBIndex,
  IDBObjectStore: IDBObjectStore,
  IDBRequest: IDBRequest,

  navigator: {
    // - connection status
    connection: {
      bandwidth: 1000,
      metered: false,
      _listener: null,
      addEventListener: function(eventName, listener) {
        this._listener = listener;
      },
      removeEventListener: function(eventName, listener) {
        this._listener = null;
      },
      TEST_setOffline: function(beOffline) {
        this.bandwidth = beOffline ? 0 : 1000;
        if (this._listener)
          this._listener({});
      }
    },
    mozAlarms: {
      add: function() {},
      get: function() {},
      getAll: function() {},
    },
    mozSetMessageHandler: function() {},
    mozHasPendingMessage: function() {
      return false;
    },
  },

  URL: {
    createObjectURL: function(fakeBlob) {
      var fakeURL = 'url:' + fakeBlob.str;
      __blobLogFunc('createObjectURL', fakeURL);
      return fakeURL;
    },
    revokeObjectURL: function(fakeURL) {
      __blobLogFunc('revokeObjectURL', fakeURL);
    },
  },

  // - general stuff
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setZeroTimeout: function(callback) {
    var tm = Components.classes["@mozilla.org/thread-manager;1"]
                       .getService(Components.interfaces.nsIThreadManager);

    tm.mainThread.dispatch({
      run: function() {
        try {
          callback();
        } catch (e) {
          ErrorTrapper.fire('uncaughtException', e);
        }
      }
    }, Components.interfaces.nsIThread.DISPATCH_NORMAL);
  },

  btoa: function(data) {
    try {
      return moduleGlobalsHack.btoa(data);
    }
    catch(ex) {
      throw new Error("btoa of '" + data + "' failed.");
    }
  },
  atob: function(data) {
    try {
      return moduleGlobalsHack.atob(data);
    }
    catch(ex) {
      throw new Error("atob of '" + data + "' failed.");
    }
  },
  document: {
    implementation: {
      createHTMLDocument: function createHTMLDocument(str) {
        var parser = Cc["@mozilla.org/xmlextras/domparser;1"]
              .createInstance(Ci.nsIDOMParser);
        parser.init();
        return parser.parseFromString(str, 'text/html');
      }
    }
  }
};

// mix all the window stuff into the global scope for things like the string
// encoding polyfill that really want 'this' and window to be the same.
var window = this, self = this;
(function(win) {
  for (var key in _window_mixin) {
    win[key] = _window_mixin[key];
  }
}(this));
// during the RequireJS bootstrap, have navigator be undefined.
navigator = undefined;

function Blob(parts, properties) {
  this.parts = parts;
  this.properties = properties;

  this.str = parts[0].toString();

  __blobLogFunc('createBlob', this.str);
}
Blob.prototype = {
};
