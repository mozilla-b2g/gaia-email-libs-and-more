/**
 * Implements the ActiveSync protocol for Hotmail and Exchange.
 **/

import logic from 'logic';
import $acctmixins from '../../accountmixins';
import $wbxml from 'wbxml';
import $asproto from 'activesync/protocol';
import ASCP from 'activesync/codepages';


// XXX pull out of syncbase instead
var DEFAULT_TIMEOUT_MS = 30 * 1000;

function ActiveSyncAccount(universe, accountDef, foldersTOC, dbConn,
                           receiveProtoConn) {
  this.universe = universe;
  this.id = accountDef.id;
  this.accountDef = accountDef;

  this._db = dbConn;

  logic.defineScope(this, 'Account', { accountId: this.id,
                                       accountType: 'activesync' });

  if (receiveProtoConn) {
    this.conn = receiveProtoConn;
    this._attachLoggerToConnection(this.conn);
  }
  else {
    this.conn = null;
  }

  this.enabled = true;
  this.problems = [];
  this._alive = true;

  this.identities = accountDef.identities;

  this.foldersTOC = foldersTOC;
  // this is owned by the TOC.  Do not mutate!
  this.folders = this.foldersTOC.items;
  this.meta = foldersTOC.meta;

  this._syncsInProgress = 0;
  this._lastSyncKey = null;
  this._lastSyncResponseWasEmpty = false;
}
ActiveSyncAccount.prototype = {
  type: 'activesync',
  supportsServerFolders: true,
  toString: function asa_toString() {
    return '[ActiveSyncAccount: ' + this.id + ']';
  },

  // TODO: evaluate whether the account actually wants to be a RefedResource
  // with some kind of reaping if all references die and no one re-acquires it
  // within some timeout horizon.
  __acquire: function() {
    return Promise.resolve(this);
  },
  __release: function() {
  },

  /**
   * Manages connecting, and wiring up initial connection if it is not
   * initialized yet.
   */
  withConnection: function (errback, callback, failString) {
    if (!this.conn) {
      var accountDef = this.accountDef;
      this.conn = new $asproto.Connection(accountDef.connInfo.deviceId);
      this._attachLoggerToConnection(this.conn);
      this.conn.open(accountDef.connInfo.server,
                     accountDef.credentials.username,
                     accountDef.credentials.password);
      this.conn.timeout = DEFAULT_TIMEOUT_MS;
    }

    if (!this.conn.connected) {
      logic(this, 'connecting');
      this.conn.connect(function(error) {
        if (error) {
          this._reportErrorIfNecessary(error);
          // If the error was HTTP 401 (bad user/pass), report it as
          // bad-user-or-pass so that account logic like
          // _cmd_clearAccountProblems knows whether or not to report
          // the error as user-serviceable.
          if (this._isBadUserOrPassError(error) && !failString) {
            failString = 'bad-user-or-pass';
          }
          errback(failString || 'unknown');
          return;
        }
        logic(this, 'connected', { connected: this.conn.connected });
        callback();
      }.bind(this));
    } else {
      callback();
    }
  },

  /**
   * Returns a Promise that is resolved with the connection when it has
   * successfully established, or rejected if we could not establish one.  For
   * example, because we're offline or the password is bad or whatever.
   *
   * Reminder: ActiveSync connections are notional; we're mainly just verifying
   * our credentials are still good and getting updated options/protocol version
   * info.  (And being bounced the right endpoint for future requests.)
   */
  ensureConnection: function() {
    if (this.conn && this.conn.connected) {
      return Promise.resolve(this.conn);
    }
    return new Promise((resolve, reject) => {
      this.withConnection(
        reject,
        () => {
          resolve(this.conn);
        }
      );
    });
  },

  _isBadUserOrPassError: function(error) {
    return (error &&
            error instanceof $asproto.HttpError &&
            error.status === 401);
  },

  /**
   * Reports the error to the user if necessary.
   */
  _reportErrorIfNecessary: function(error) {
    if (!error) {
      return;
    }

    logic(this, 'reportErrorIfNecessary', { error });

    if (this._isBadUserOrPassError(error)) {
      // prompt the user to try a different password
      this.universe.__reportAccountProblem(
        this, 'bad-user-or-pass', 'incoming');
    }
  },


  _attachLoggerToConnection: function(conn) {
    logic.defineScope(conn, 'ActiveSyncConnection',
                      { connectionId: logic.uniqueId() });
    if (!logic.isCensored) {
      conn.onmessage = this._onmessage_dangerous.bind(this, conn);
    } else {
      conn.onmessage = this._onmessage_safe.bind(this, conn);
    }
  },

  /**
   * Basic onmessage ActiveSync protocol logging function.  This does not
   * include user data and is intended for safe circular logging purposes.
   */
  _onmessage_safe: function onmessage(conn,
      type, special, xhr, params, extraHeaders, sentData, response) {
    if (type === 'options') {
      logic(conn, 'options', { special: special,
                               status: xhr.status,
                               response: response });
    }
    else {
      logic(conn, 'command', { type: type,
                               special: special,
                               status: xhr.status });
    }
  },

  /**
   * Dangerous onmessage ActiveSync protocol logging function.  This is
   * intended to log user data for unit testing purposes or very specialized
   * debugging only.
   */
  _onmessage_dangerous: function onmessage(conn,
      type, special, xhr, params, extraHeaders, sentData, response) {
    if (type === 'options') {
      logic(conn, 'options', { special: special,
                               status: xhr.status,
                               response: response });
    }
    else {
      var sentXML, receivedXML;
      if (sentData) {
        try {
          var sentReader = new $wbxml.Reader(new Uint8Array(sentData), ASCP);
          sentXML = sentReader.dump();
        }
        catch (ex) {
          sentXML = 'parse problem';
        }
      }
      if (response) {
        try {
          receivedXML = response.dump();
          response.rewind();
        }
        catch (ex) {
          receivedXML = 'parse problem';
        }
      }

      logic(conn, 'command', { type: type,
                               special: special,
                               status: xhr.status,
                               params: params,
                               extraHeaders: extraHeaders,
                               sentXML: sentXML,
                               receivedXML: receivedXML });
    }
  },

  get numActiveConns() {
    return 0;
  },

  /**
   * Check that the account is healthy in that we can login at all.
   */
  checkAccount: function(callback) {
    // disconnect first so as to properly check credentials
    if (this.conn != null) {
      if (this.conn.connected) {
        this.conn.disconnect();
      }
      this.conn = null;
    }
    this.withConnection(function(err) {
      callback(err);
    }, function() {
      callback();
    });
  },

  shutdown: function(callback) {
    if (callback) {
      callback();
    }
  },

  accountDeleted: function() {
    this._alive = false;
    this.shutdown();
  },

  /**
   * Ensure that local-only folders live in a reasonable place in the
   * folder hierarchy by moving them if necessary.
   *
   * We proactively create local-only folders at the root level before
   * we synchronize with the server; if possible, we want these
   * folders to reside as siblings to other system-level folders on
   * the account. This is called at the end of syncFolderList, after
   * we have learned about all existing server folders.
   */
  normalizeFolderHierarchy: $acctmixins.normalizeFolderHierarchy,

  getFirstFolderWithType: $acctmixins.getFirstFolderWithType,
  getFolderByPath: $acctmixins.getFolderByPath,
  getFolderById: $acctmixins.getFolderById,
  getFolderByServerId: function(serverId) {
    var folders = this.folders;
    for (var iFolder = 0; iFolder < folders.length; iFolder++) {
      if (folders[iFolder].serverId === serverId) {
        return folders[iFolder];
      }
    }
   return null;
 },
  saveAccountState: $acctmixins.saveAccountState,
  runAfterSaves: $acctmixins.runAfterSaves,

  allOperationsCompleted: function() {
  }
};

export default ActiveSyncAccount;
