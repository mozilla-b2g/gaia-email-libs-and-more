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
var __deviceStorageLogFunc = function() {
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

  XMLHttpRequest: function() {
    var inst = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                 .createInstance(Ci.nsIXMLHttpRequest);
    var realOpen = inst.open;
    inst.open = function(method, url, async) {
      // We do not like relative URLs because we lack a base URL since we
      // exist in chrome space, so let's do the minimum required to get a nice
      // 404.
      // XXX it would be nice if we had local copies of the same local
      // autoconfig db used in the gaia repo and could map to them with file
      // url's in here.
      if (url[0] === '/')
        url = 'http://localhost' + url;
      realOpen.call(inst, method, url, async);
    };
    return inst;
  },
  DOMParser: function() {
    var parser = Cc["@mozilla.org/xmlextras/domparser;1"]
                   .createInstance(Ci.nsIDOMParser);
    parser.init();
    // XXX we really need to wrap the parser's parser methods in try/catch
    // blocks because in content space parseFromString does not throw.
    return parser;
  },
  XPathResult: {
    ANY_TYPE: 0,
    NUMBER_TYPE: 1,
    STRING_TYPE: 2,
    BOOLEAN_TYPE: 3,
    UNORDERED_NODE_ITERATOR_TYPE: 4,
    ORDERED_NODE_ITERATOR_TYPE: 5,
    UNORDERED_NODE_SNAPSHOT_TYPE: 6,
    ORDERED_NODE_SNAPSHOT_TYPE: 7,
    ANY_UNORDERED_NODE_TYPE: 8,
    FIRST_ORDERED_NODE_TYPE: 9
  },

  _listeners: {
    offline: [],
    online: [],
  },
  addEventListener: function(eventName, listener) {
    if (!this._listeners.hasOwnProperty(eventName))
      return;
    this._listeners[eventName].push(listener);
  },
  removeEventListener: function(eventName, listener) {
    if (!this._listeners.hasOwnProperty(eventName))
      return;
    var listeners = this._listeners[eventName],
        idx = listeners.indexOf(listener);
    if (idx !== -1)
      listeners.splice(idx, 1);
  },
  _fireFakeEvent: function(eventName) {
    var eventObj = {};
    var listeners = this._listeners[eventName].concat();
    listeners.forEach(function(listener) {
      listener(eventObj);
    });
  },
  navigator: {
    // - connection status
    // annoyingly, B2G does not support mozConnection
    onLine: true,

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
        window.navigator.onLine = !beOffline;

        this.bandwidth = beOffline ? 0 : 1000;
        if (this._listener)
          this._listener({});
        if (beOffline)
          window._fireFakeEvent('offline');
        else
          window._fireFakeEvent('online');
      }
    },
    mozApps: {
      getSelf: function() {
        var req = { onsuccess: null, onerror: null },
            app = { installOrigin: '' };
        window.setZeroTimeout(function() {
          if (req.onsuccess)
            req.onsuccess({
              target: {
                result: app,
              }
            });
        });
        return req;
      },
    },
    // By default we start up disabled, so it's not really a biggie either way.
    mozAlarms: {
      add: function() {},
      get: function() {},
      getAll: function() {},
      remove: function() {},
    },

    getDeviceStorage: function(ds) {
      return {
        addNamed: function(blob, name) {
          __deviceStorageLogFunc('addNamed:' + ds, name);
          _FAKE_DEVICE_STORAGE[ds + ':' + name] = blob;
          var req = {
            onsuccess: null,
            onerror: null
          };
          window.setZeroTimeout(function() {
            if (req.onsuccess)
              req.onsuccess({ target: req });
          });
          return req;
        },
        'get': function(name) {
          __deviceStorageLogFunc('get:' + ds, name);
          var req = {
            onsuccess: null,
            onerror: null,
            result: null
          };
          window.setZeroTimeout(function() {
            req.result = _FAKE_DEVICE_STORAGE[ds + ':' + name];
            req.onsuccess({ target: req });
          });
          return req;
        },
      };
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

var _FAKE_DEVICE_STORAGE = {};

function Blob(parts, properties) {
  this.parts = parts;
  this.properties = properties;
  this.type = properties.type;
  this.endings = properties.endings;

  this.str = parts[0].toString();
  this.size = this.str.length;

  __blobLogFunc('createBlob', this.str);
}
Blob.prototype = {
};

function FileReader() {
  this.onload = null;
}
FileReader.prototype = {
  readAsArrayBuffer: function(blob) {
    var self = this;
    window.setZeroTimeout(function() {
      var arr = blob.parts[0];
      self.result = arr;
      if (self.onload)
        self.onload(arr);
    });
  }
};
