define(function(require) {

/**
 * Helper that just ensures we have a connection and then calls the underlying
 * connection method.
 */
function simpleWithConn(methodName) {
  return function() {
    let calledArgs = arguments;
    return this._gimmeConnection.then((conn) => {
    });
      return conn[methodName].apply(conn, calledArgs);
  }
}

/**
 * Helper where the first argument is the folder we need to be in when we make
 * the actual wrapped call.  This is accomplished via a browserbox precheck
 * operation so it should be reasonably efficient.
 */
function inFolderWithConn(methodName, optsArgIndexPerCaller) {
  return function(folderInfo) {
    let calledArgs = arguments;
    return this._gimmeConnection.then((conn) => {
      let opts = calledArgs[optsArgIndexPerCaller];

    });
  }
}

/**
 * Coordinates IMAP usage so that we can run things faster, unambigously
 * pipeline things, avoid gratuitous folder-switching, etc.  The fundamental
 * idea is that callers don't need to know or care about connection usage.  They
 * just care about results.
 *
 * For mutations or other things where there are side-effects from our calls,
 * return values are always defined to disambiguate as well as the caller could
 * given the same information (and without establishing new connections.)
 *
 * XXX TODO: Implement retrying of commands that were the result of a connection
 * loss with some suspicion level so that commands that cause us to lose the
 * connection eventually do fail.  Right now our various abstractions result in
 * failures always turning into connection loss and we're developing on highly
 * reliable desktop connections, so it's advisable to skimp to avoid
 * accidentally creating DoS's since most failures are likely to be because of
 * our code simply doing something incorrect and triggering an error.
 *
 * TODO: Actually support doing things in parallel.  For now, we just use one
 * connection.
 *
 * TODO: Ideally take ownership of the connection creation/management logic in
 * ImapAccount and then clean things up a bit as it relates to life-cycle
 * management.  (But we do 100% want to keep the back-off logic and the concept
 * of different failure modes.  Don't rip that out.)
 *
 * KEEP IN MIND: BrowserBox has a straight-forward API and internal queue
 * mechanism.  Although there is some minor stateful stuff as it relates to
 * being in a folder, it may be possible to upstream much of this logic.  We
 * probably want to see how this turns out first, though.
 */
function ParallelIMAP(imapAccount) {
  this._imapAccount = imapAccount;

  this._conn = null;
  this._connPromise = null;
}
ParallelIMAP.prototype = {
  // XXX the interaction of this and simpleWithConn are pretty ugly.
  _gimmeConnection: function() {
    if (this._conn) {
      // (keeping the promise around forever can make devtools sad and result in
      // effective memory leaks, at least allegedly per co.  makes sense, tho.)
      return Promise.resolve(this._conn);
    }
    if (this._connPromise) {
      return this._connPromise;
    }

    this._connPromise = new Promise((resolve, reject) => {
      this._imapAccount.__folderDemandsConnection(
        null,
        'pimap',
        (conn) => {
          this._conn = conn;
          this._connPromise = null;
          resolve(conn);
        },
        () => {
          this._conn = null;
          this._connPromise = null;
          reject();
        })
    });
    return this._connPromise;
  },

  listMailboxes: simpleWithConn('listMailboxes'),
  listMessages: simpleWithConn('listMessages'),
  listNamespaces: simpleWithConn('listNamespaces'),
  search: simpleWithConn('search'),

};

return ParallelIMAP;
});
