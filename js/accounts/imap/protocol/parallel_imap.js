import logic from 'logic';
import mimefuncs from 'mimefuncs';

/**
 * Helper that just ensures we have a connection and then calls the underlying
 * connection method.
 */
export function simpleWithConn(methodName) {
  return function(taskCtx, ...bbArgs) {
    return this._gimmeConnection().then((conn) => {
      logic(this, methodName + ':begin', { ctxId: taskCtx.id });
      return conn[methodName].apply(conn, bbArgs).then((value) => {
        logic(this, methodName + ':end', { ctxId: taskCtx.id, _result: value });
        // NB: if we were going to return the connection, this is where we would
        // do it.
        return value;
      });
    });
  };
}

/**
 * Helper where the first argument is the folderInfo of the folder we need to be
 * in when we make the actual wrapped call.  This is accomplished via a
 * browserbox precheck operation so it should be reasonably efficient.
 *
 * TODO: Provide a way to indicate that an explicit re-SELECT is desired prior
 * to executing the command.  Right now we won't re-SELECT if we're already in
 * the folder.  (And/or perform a NOOP.)
 */
export function inFolderWithConn(methodName, optsArgIndexPerCaller) {
  return function(taskCtx, folderInfo, ...bbArgs) {
    return this._gimmeConnection().then((conn) => {
      let opts = bbArgs[optsArgIndexPerCaller];
      if (!opts) {
        throw new Error('provide the options dictionary so we can mutate it.');
      }
      opts.precheck = function(ctx, next) {
        // Only select the folder if we're not already inside it.
        if (folderInfo.path !== conn.selectedMailboxPath) {
          conn.selectMailbox(folderInfo.path, { ctx: ctx }, next);
        } else {
          next();
        }
      };
      logic(
        this, methodName + ':begin',
        { ctxId: taskCtx.id, folderId: folderInfo.id });
      return conn[methodName].apply(conn, bbArgs).then((value) => {
        logic(
          this, methodName + ':end',
          { ctxId: taskCtx.id, _result: value });
        // NB: if we were going to return the connection, this is where we would
        // do it.
        return {
          mailboxInfo: conn.selectedMailboxInfo,
          result: value
        };
      });
    });
  };
}

/**
 * Wrap a promise-returning function so that we invoke it when we have a
 * connection.  The first argument we provide is the connection, the second is
 * the precheck function that should be passed in as part of the options dict
 * to the browserbox function so it can ensure the correct folder is currently
 * used.
 */
export function customFuncInFolderWithConn(implFunc) {
  return function(taskCtx, folderInfo, ...bbArgs) {
    let methodName = implFunc.name;
    return this._gimmeConnection().then((conn) => {
      let precheck = function(ctx, next) {
        // Only select the folder if we're not already inside it.
        if (folderInfo.path !== conn.selectedMailboxPath) {
          conn.selectMailbox(folderInfo.path, { ctx: ctx }, next);
        } else {
          next();
        }
      };
      logic(
        this, methodName + ':begin',
        { ctxId: taskCtx.id, folderId: folderInfo.id });
      return implFunc.apply(
        this,
        [conn, precheck].concat(bbArgs)
      ).then((value) => {
        logic(
          this, methodName + ':end',
          { ctxId: taskCtx.id, _result: value });
        return {
          mailboxInfo: conn.selectedMailboxInfo,
          result: value
        };
      });
    });
  };
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
export default function ParallelIMAP(imapAccount) {
  logic.defineScope(this, 'ParallelIMAP', { accountId: imapAccount.id });
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

    logic(this, 'demandConnection');
    this._connPromise = new Promise((resolve, reject) => {
      this._imapAccount.__folderDemandsConnection(
        null,
        'pimap',
        (conn) => {
          logic(this, 'gotConnection');
          this._conn = conn;
          this._connPromise = null;
          resolve(conn);
        },
        () => {
          logic(this, 'deadConnection');
          this._conn = null;
          this._connPromise = null;
          reject();
        });
    });
    return this._connPromise;
  },

  listMailboxes: simpleWithConn('listMailboxes'),
  listMessages: inFolderWithConn('listMessages', 2),
  listNamespaces: simpleWithConn('listNamespaces'),
  search: inFolderWithConn('search', 1),

  // Select the mailbox returning the mailboxInfo directly (not nested in an
  // object).  If the mailbox is already selected, just return it.
  selectMailbox: function(taskCtx, folderInfo) {
    return this._gimmeConnection().then((conn) => {
      if (folderInfo.path === conn.selectedMailboxPath) {
        return Promise.resolve(conn.selectedMailboxInfo);
      }
      return conn.selectMailbox(folderInfo.path).then(() => {
        return conn.selectedMailboxInfo;
      });
    });
  },

  store: inFolderWithConn('store', 3),

  // APPEND does not require being in a folder, it just wants the path, so the
  // caller does need to manually specify it.
  upload: simpleWithConn('upload'),

  /**
   * Fetch the full or partial contents of a message part, returning a
   * Uint8Array with the contents.
   *
   * In the future, with changes to browserbox, we may be able to return a
   * stream instead of delivering the data all at once.
   */
  async fetchBody(taskCtx, folderInfo, request) {
    let conn = await this._gimmeConnection();

    let precheck = function(ctx, next) {
      // Only select the folder if we're not already inside it.
      if (folderInfo.path !== conn.selectedMailboxPath) {
        conn.selectMailbox(folderInfo.path, { ctx: ctx }, next);
      } else {
        next();
      }
    };

    logic(this, 'fetchBody:begin', { ctxId: taskCtx.id });
    let messages = await conn.listMessages(
      request.uid,
       [
        'BODY.PEEK[' + (request.part || '1') + ']' +
          (request.byteRange ?
           ('<' + request.byteRange.offset + '.' +
            request.byteRange.bytesToFetch + '>') :
           '')
      ],
      { byUid: true, precheck }
    );
    let msg = messages[0];
    let body;
    for (let key in msg) {
      if (/^body/i.test(key)) {
        body = msg[key];
        break;
      }
    }
    if (!body) {
      throw new Error('no body returned!');
    }
    logic(
      this, 'fetchBody:end',
      { ctxId: taskCtx.id, bodyLength: body.length });
    // browserbox traffics in 'binary' strings; convert this back to a
    // TypedArray.
    return mimefuncs.toTypedArray(body);
  }
};
