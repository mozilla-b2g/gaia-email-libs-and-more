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

var window = {
  // - indexed db
  mozIndexedDB: mozIndexedDB,
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
};
var navigator = undefined, document = undefined;
// new to me, but apparently it's a thing...
var self = window.self = window;
