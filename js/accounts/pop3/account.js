import logic from 'logic';
import errbackoff from '../../errbackoff';
import { CompositeIncomingAccount } from '../composite/incoming';
import errorutils from '../../errorutils';
import DisasterRecovery from '../../disaster-recovery';
import * as pop3 from './pop3';
import * as pop3probe from './probe';

/**
 * Define a POP3 account. Much of the functionality here is similar
 * to IMAP; Pop3Account inherits the shared parts from
 * CompositeIncomingAccount.
 */
function Pop3Account(universe, compositeAccount, accountId, credentials,
                     connInfo, foldersTOC, dbConn, existingProtoConn) {
  logic.defineScope(this, 'Account', { accountId: accountId,
                                       accountType: 'pop3' });

  CompositeIncomingAccount.apply(this, arguments);

  // Set up connection information. We can't make much use of
  // connection pooling since the POP3 protocol only allows one client
  // to access a mailbox at a given time, so there's no connection pool.
  this._conn = null;
  this._pendingConnectionRequests = [];
  this._backoffEndpoint = errbackoff.createEndpoint('pop3:' + this.id, this);

  // If we have an existing connection from setting up the account, we
  // can reuse that during the first sync.
  if (existingProtoConn) {
    DisasterRecovery.associateSocketWithAccount(
      existingProtoConn.socket, this);
    this._conn = existingProtoConn;
  }
}
Pop3Account.prototype = Object.create(CompositeIncomingAccount.prototype);
var properties = {
  type: 'pop3',
  supportsServerFolders: false,
  toString: function() {
    return '[Pop3Account: ' + this.id + ']';
  },

  /**
   * Call the callback with a live, authenticated connection. Clients
   * should call done() when finished with the connection. (In our
   * case, pop3/sync.js has a lazyWithConnection wrapper which
   * abstracts the `done` callback.)
   * @param {function(err, conn, done)} cb
   */
  withConnection: function(cb, whyLabel) {
    // This implementation serializes withConnection requests so that
    // we don't step on requests' toes. While Pop3Client wouldn't mix
    // up the requests themselves, interleaving different operations
    // could result in undesired consequences.
    this._pendingConnectionRequests.push(cb);
    var done = function() {
      var req = this._pendingConnectionRequests.shift();
      if (req) {
        var next = function(err) {
          if (err) {
            req(err);
            done();
          } else {
            req(null, this._conn, done);
          }
        }.bind(this);
        if (!this._conn || this._conn.state === 'disconnected') {
          this._makeConnection(next, whyLabel);
        } else {
          next();
        }
      }
    }.bind(this);

    if (this._pendingConnectionRequests.length === 1) {
      done();
    }
  },

  /**
   * Hacky mechanism that depends on the current single-task-at-a-time
   * implementation limitation of the task infrastructure to insure mutually
   * exclusive access to the connection.
   *
   * We use withConnection which is mainly just concerned about life-cycle
   * management.  The right future mechanism for this is likely to make the
   * connection a RefedResource, possibly one that will only let itself be
   * acquired by one thing at a time.  However, the exclusiveResources mechanism
   * planned for the task maanger already potentially covers this, so maybe not.
   *
   * TODO: address the connection life-cycle issues better.
   */
  ensureConnection: function() {
    if (this._conn && this._conn.state !== 'disconnected') {
      return Promise.resolve(this._conn);
    }
    return new Promise((resolve, reject) => {
      this.withConnection((err, conn) => {
        if (err) {
          reject(err);
        } else {
          resolve(conn);
        }
      });
    });
  },

  /** @override */
  __folderDoneWithConnection: function(/*conn*/) {
    // IMAP uses this function to perform folder-specific connection cleanup.
    // We don't need to do anything here.
  },

  /**
   * Create a new POP3 connection, and call the callback when we
   * have established the connection (or with an error if we failed).
   * Since POP3 only uses one connection at a time, this function also
   * assigns the given connection to this._conn.
   *
   * Don't use this function directly; instead use `withConnection` or
   * a higher-level wrapper.
   *
   * @param {function(err, conn)} callback
   * @param {String} whyLabel A descriptive name for the connection.
   */
  _makeConnection: function(callback, whyLabel) {
    // Mark a pending connection synchronously; the require call will
    // not return until at least the next turn of the event loop, so
    // we need to know that there's a pending connection request in
    // progress.
    this._conn = true;
    // NB: we used to dynamically load ./pop3 and ./probe here, but with all
    // the overhauls going on, I'm removing this for now.  It may make sense
    // to redo this later.
    logic(this, 'createConnection', { label: whyLabel });
    var opts = {
      host: this._connInfo.hostname,
      port: this._connInfo.port,
      crypto: this._connInfo.crypto,

      preferredAuthMethod: this._engineData.preferredAuthMethod,

      username: this._credentials.username,
      password: this._credentials.password,
    };

    var conn = this._conn = new pop3.Pop3Client(opts, function(err) {
      if (err) {
        // Failed to get the connection:
        console.error('Connect error:', err.name, 'formal:', err, 'on',
                      this._connInfo.hostname, this._connInfo.port);

        err = pop3probe.normalizePop3Error(err);

        if (errorutils.shouldReportProblem(err)) {
          this.universe.__reportAccountProblem(
            this.compositeAccount, err, 'incoming');
        }

        callback && callback(err, null);
        conn.close();

        // Track this failure for backoff purposes.
        if (errorutils.shouldRetry(err)) {
          if (this._backoffEndpoint.noteConnectFailureMaybeRetry(
            errorutils.wasErrorFromReachableState(err))) {
            this._backoffEndpoint.scheduleConnectAttempt(
              this._makeConnection.bind(this));
           } else {
             this._backoffEndpoint.noteBrokenConnection();
          }
        } else {
          this._backoffEndpoint.noteBrokenConnection();
        }
      }
      // Succeeded:
      else {
        this._backoffEndpoint.noteConnectSuccess();
        callback && callback(null, conn);
      }
    }.bind(this));

    DisasterRecovery.associateSocketWithAccount(conn.socket, this);
  },

  /**
   * Shut down the account and close the connection.
   */
  shutdown: function(callback) {
    this._backoffEndpoint.shutdown();

    if (this._conn && this._conn.close) {
      this._conn.close();
    }
    callback && callback();
  },

  /**
   * Attempt to create a new, authenticated connection using the
   * current credentials. If a current connection is already
   * established, terminates the existing connection first.
   *
   * @param {function(err)} callback
   */
  checkAccount: function(callback) {
    // Disconnect first so as to properly check credentials.
    if (this._conn !== null) {
      if (this._conn.state !== 'disconnected') {
        this._conn.close();
      }
      this._conn = null;
    }
    logic(this, 'checkAccount_begin');
    this.withConnection(function(err) {
      logic(this, 'checkAccount_end', { error: err });
      callback(err);
    }.bind(this), 'checkAccount');
  },

  /**
   * Destroy the account when the account has been deleted.
   */
  accountDeleted: function() {
    this._alive = false;
    this.shutdown();
  },

};

// Inherit Pop3Account from CompositeIncomingAccount:
// XXX: Use mix.js when it lands in the streaming patch.
for (var k in properties) {
  Object.defineProperty(Pop3Account.prototype, k,
                        Object.getOwnPropertyDescriptor(properties, k));
}

export { Pop3Account, Pop3Account as Account };
