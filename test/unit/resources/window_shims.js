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
  handle();
}


var window = {
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

  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
};
var navigator = undefined, document = undefined;
