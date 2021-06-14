import logic from 'logic';
import $errbackoff from '../../errbackoff';
import { KILL_CONNECTIONS_WHEN_JOBLESS, STALE_CONNECTION_TIMEOUT_MS } from '../../syncbase';
import { CompositeIncomingAccount } from '../composite/incoming';
import * as $imapclient from './client';
import ParallelImap from './protocol/parallel_imap';
import errorutils from '../../errorutils';
import DisasterRecovery from '../../disaster-recovery';


/**
 * Account object, root of all interaction with servers.
 *
 * Passwords are currently held in cleartext with the rest of the data.  Ideally
 * we would like them to be stored in some type of keyring coupled to the TCP
 * API in such a way that we never know the API.  Se a vida e.
 *
 */
export function ImapAccount(universe, compositeAccount, accountId, credentials,
                     connInfo, foldersTOC,
                     dbConn, existingProtoConn) {
  logic.defineScope(this, 'Account',
                    { accountId, accountType: 'imap' });
  CompositeIncomingAccount.apply(this, arguments);

  /**
   * The maximum number of connections we are allowed to have alive at once.  We
   * want to limit this both because we generally aren't sophisticated enough
   * to need to use many connections at once (unless we have bugs), and because
   * servers may enforce a per-account connection limit which can affect both
   * us and other clients on other devices.
   *
   * Thunderbird's default for this is 5.
   *
   * gmail currently claims to have a limit of 15 connections per account:
   * http://support.google.com/mail/bin/answer.py?hl=en&answer=97150
   *
   * I am picking 3 right now because it should cover the "I just sent a
   * messages from the folder I was in and then switched to another folder",
   * where we could have stuff to do in the old folder, new folder, and sent
   * mail folder.  I have also seem claims of connection limits of 3 for some
   * accounts out there, so this avoids us needing logic to infer a need to
   * lower our connection limit.
   */
  this._maxConnsAllowed = 3;
  /**
   * The `ImapConnection` we are attempting to open, if any.  We only try to
   * open one connection at a time.
   */
  this._pendingConn = null;
  this._ownedConns = [];
  /**
   * @listof[@dict[
   *   @key[folderId]
   *   @key[callback]
   * ]]{
   *   The list of requested connections that have not yet been serviced.  An
   * }
   */
  this._demandedConns = [];
  this._backoffEndpoint = $errbackoff.createEndpoint('imap:' + this.id, this);

  this.pimap = new ParallelImap(this);

  if (existingProtoConn) {
    this._reuseConnection(existingProtoConn);
  }

  /**
   * Flag to allow us to avoid calling closeBox to close a folder.  This avoids
   * expunging deleted messages.
   */
  this._TEST_doNotCloseFolder = false;
}
export { ImapAccount as Account };
ImapAccount.prototype = Object.create(CompositeIncomingAccount.prototype);
var properties = {
  type: 'imap',
  supportsServerFolders: true,
  toString: function() {
    return '[ImapAccount: ' + this.id + ']';
  },

  get capability() {
    return this._engineData.capability;
  },

  //////////////////////////////////////////////////////////////////////////////
  // Server type indicators for quirks and heuristics like sent mail

  /**
   * Is this server gmail?  Not something that just looks like gmail, but IS
   * gmail.
   *
   * Gmail self-identifies via the nonstandard but documented X-GM-EXT-1
   * capability.  Documentation is at
   * https://developers.google.com/gmail/imap_extensions
   */
  get isGmail() {
    return this.capability.indexOf('X-GM-EXT-1') !== -1;
  },

  /**
   * Is this a CoreMail server, as used by 126.com/163.com/others?
   *
   * CoreMail servers self-identify via the apparently cargo-culted
   * X-CM-EXT-1 capability.
   */
  get isCoreMailServer() {
    return this.capability.indexOf('X-CM-EXT-1') !== -1;
  },

  /**
   * Do messages sent via the corresponding SMTP account automatically show up
   * in the sent folder?  Both Gmail and CoreMail do this.  (It's a good thing
   * to do, it just sucks that there's no explicit IMAP capability, etc. to
   * indicate this without us having to infer from the server type.  Although
   * we could probe this if we wanted...)
   */
  get sentMessagesAutomaticallyAppearInSentFolder() {
    return this.isGmail || this.isCoreMailServer;
  },

  //////////////////////////////////////////////////////////////////////////////
  // Connection Pool-ish stuff

  get numActiveConns() {
    return this._ownedConns.length;
  },

  /**
   * Mechanism for an `ImapFolderConn` to request an IMAP protocol connection.
   * This is to potentially support some type of (bounded) connection pooling
   * like Thunderbird uses.  The rationale is that many servers cap the number
   * of connections we are allowed to maintain, plus it's hard to justify
   * locally tying up those resources.  (Thunderbird has more need of watching
   * multiple folders than ourselves, but we may still want to synchronize a
   * bunch of folders in parallel for latency reasons.)
   *
   * The provided connection will *not* be in the requested folder; it's up to
   * the folder connection to enter the folder.
   *
   * @args[
   *   @param[folderId #:optional FolderId]{
   *     The folder id of the folder that will be using the connection.  If
   *     it's not a folder but some task, then pass null (and ideally provide
   *     a useful `label`).
   *   }
   *   @param[label #:optional String]{
   *     A human readable explanation of the activity for debugging purposes.
   *   }
   *   @param[callback @func[@args[@param[conn]]]]{
   *     The callback to invoke once the connection has been established.  If
   *     there is a connection present in the reuse pool, this may be invoked
   *     immediately.
   *   }
   *   @param[deathback Function]{
   *     A callback to invoke if the connection dies or we feel compelled to
   *     reclaim it.
   *   }
   *   @param[dieOnConnectFailure #:optional Boolean]{
   *     Should we invoke the deathback for this request if we fail to establish
   *     a connection in a timely manner?  This will be immediately invoked if
   *     we are offline or if we exhaust our retries for establishing
   *     connections with the server.
   *   }
   * ]
   */
  __folderDemandsConnection: function(folderId, label, callback, deathback,
                                      dieOnConnectFailure) {
    // If we are offline, invoke the deathback soon and don't bother trying to
    // get a connection.
    if (dieOnConnectFailure && !this.universe.online) {
      globalThis.setTimeout(deathback, 0);
      return;
    }

    var demand = {
      folderId: folderId,
      label: label,
      callback: callback,
      deathback: deathback,
      dieOnConnectFailure: Boolean(dieOnConnectFailure)
    };
    this._demandedConns.push(demand);

    // No line-cutting; bail if there was someone ahead of us.
    if (this._demandedConns.length > 1) {
      return;
    }

    // - try and reuse an existing connection
    if (this._allocateExistingConnection()) {
      return;
    }

    // - we need to wait for a new conn or one to free up
    this._makeConnectionIfPossible();

    return;
  },

  /**
   * Trigger the deathbacks for all connection demands where dieOnConnectFailure
   * is true.
   */
  _killDieOnConnectFailureDemands: function() {
    for (var i = 0; i < this._demandedConns.length; i++) {
      var demand = this._demandedConns[i];
      if (demand.dieOnConnectFailure) {
        demand.deathback.call(null);
        this._demandedConns.splice(i--, 1);
      }
    }
  },

  /**
   * Try and find an available connection and assign it to the first connection
   * demand.
   *
   * @return[Boolean]{
   *   True if we allocated a demand to a conncetion, false if we did not.
   * }
   */
  _allocateExistingConnection: function() {
    if (!this._demandedConns.length) {
      return false;
    }
    var demandInfo = this._demandedConns[0];

    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      // It's concerning if the folder already has a connection...
      if (demandInfo.folderId && connInfo.folderId === demandInfo.folderId) {
        logic(this, 'folderAlreadyHasConn', { folderId: demandInfo.folderId });
      }

      if (connInfo.inUseBy) {
        continue;
      }

      connInfo.inUseBy = demandInfo;
      this._demandedConns.shift();
      logic(this, 'reuseConnection',
            { folderId: demandInfo.folderId, label: demandInfo.label });
      demandInfo.callback(connInfo.conn);
      return true;
    }

    return false;
  },

  /**
   * All our operations completed; let's think about closing any connections
   * they may have established that we don't need anymore.
   */
  allOperationsCompleted: function() {
    this.maybeCloseUnusedConnections();
  },

  /**
   * Using great wisdom, potentially close some/all connections.
   */
  maybeCloseUnusedConnections: function() {
    // XXX: We are closing unused connections in an effort to stem
    // problems associated with unreliable cell connections; they
    // tend to be dropped unceremoniously when left idle for a
    // long time, particularly on cell networks. NB: This will
    // close the connection we just used, unless someone else is
    // waiting for a connection.
    if (KILL_CONNECTIONS_WHEN_JOBLESS &&
        !this._demandedConns.length &&
        !this.universe.areServerJobsWaiting(this)) {
      this.closeUnusedConnections();
    }
  },

  /**
   * Close all connections that aren't currently in use.
   */
  closeUnusedConnections: function() {
    for (var i = this._ownedConns.length - 1; i >= 0; i--) {
      var connInfo = this._ownedConns[i];
      if (connInfo.inUseBy) {
        continue;
      }
      console.log('Killing unused IMAP connection.');
      // this eats all future notifications, so we need to splice...
      this._ownedConns.splice(i, 1);
      connInfo.conn.client.close();
      logic(this, 'deadConnection', { reason: 'unused' });
    }
  },

  _makeConnectionIfPossible: function() {
    if (this._ownedConns.length >= this._maxConnsAllowed) {
      logic(this, 'maximumConnsNoNew');
      return;
    }
    if (this._pendingConn) {
      return;
    }

    this._pendingConn = true;
    var boundMakeConnection = this._makeConnection.bind(this);
    this._backoffEndpoint.scheduleConnectAttempt(boundMakeConnection);
  },

  _makeConnection: function(callback, whyFolderId, whyLabel) {
    // Mark a pending connection synchronously; the require call will not return
    // until at least the next turn of the event loop.
    this._pendingConn = true;
    logic(this, 'createConnection', {
      folderId: whyFolderId,
      label: whyLabel
    });

    $imapclient.createImapConnection(
      this._credentials,
      this._connInfo,
      function onCredentialsUpdated() {
        return new Promise(function(resolve) {
          // Note: Since we update the credentials object in-place,
          // there's no need to explicitly assign the changes here;
          // just save the account information.
          this.universe.saveAccountDef(
            this.compositeAccount.accountDef,
            /* folderDbState: */ null,
            /* callback: */ resolve);
        }.bind(this));
      }.bind(this)
    ).then(function(conn) {
        DisasterRecovery.associateSocketWithAccount(conn.client.socket, this);

        this._pendingConn = null;
        this._bindConnectionDeathHandlers(conn);
        this._backoffEndpoint.noteConnectSuccess();
        this._ownedConns.push({
          conn: conn,
          inUseBy: null
        });
        this._allocateExistingConnection();

        // If more connections are needed, keep connecting.
        if (this._demandedConns.length) {
          this._makeConnectionIfPossible();
        }

        callback && callback(null);
      }.bind(this))
    .catch(function(err) {
        logic(this, 'deadConnection', {
          reason: 'connect-error',
          folderId: whyFolderId
        });

        if (errorutils.shouldReportProblem(err)) {
          this.universe.__reportAccountProblem(
            this.compositeAccount,
            err,
            'incoming');
        }

        this._pendingConn = null;
        callback && callback(err);

        // Track this failure for backoff purposes.
        if (errorutils.shouldRetry(err)) {
          if (this._backoffEndpoint.noteConnectFailureMaybeRetry(
            errorutils.wasErrorFromReachableState(err))) {
            this._makeConnectionIfPossible();
          } else {
            this._killDieOnConnectFailureDemands();
          }
        } else {
          this._backoffEndpoint.noteBrokenConnection();
          this._killDieOnConnectFailureDemands();
        }
    }.bind(this));
  },

  /**
   * Treat a connection that came from the IMAP prober as a connection we
   * created ourselves.
   */
  _reuseConnection: function(existingProtoConn) {
    DisasterRecovery.associateSocketWithAccount(
      existingProtoConn.client.socket, this);
    this._ownedConns.push({
      conn: existingProtoConn,
      inUseBy: null
    });
    this._bindConnectionDeathHandlers(existingProtoConn);
  },

  _bindConnectionDeathHandlers: function(conn) {
    conn.breakIdle(function() {
      conn.client.TIMEOUT_ENTER_IDLE = STALE_CONNECTION_TIMEOUT_MS;
      conn.client.onidle = function() {
        console.warn('Killing stale IMAP connection.');
        conn.client.close();
      };

      // Reenter the IDLE state here so that we properly time out if
      // we never send any further requests (which would normally
      // cause _enterIdle to be called when the request queue has been
      // emptied).
      conn.client._enterIdle();
    });

    conn.onclose = function() {
       for (var i = 0; i < this._ownedConns.length; i++) {
        var connInfo = this._ownedConns[i];
        if (connInfo.conn === conn) {
          logic(this, 'deadConnection', {
            reason: 'closed',
            folderId: connInfo.inUseBy &&
              connInfo.inUseBy.folderId
          });
          if (connInfo.inUseBy && connInfo.inUseBy.deathback) {
            connInfo.inUseBy.deathback(conn);
          }
          connInfo.inUseBy = null;
          this._ownedConns.splice(i, 1);
          return;
        }
      }
    }.bind(this);

    conn.onerror = function(err) {
      err = $imapclient.normalizeImapError(conn, err);
      logic(this, 'connectionError', { error: err });
      console.error('imap:onerror', JSON.stringify({
        error: err,
        host: this._connInfo.hostname,
        port: this._connInfo.port
      }));
    }.bind(this);
  },

  __folderDoneWithConnection: function(conn, closeFolder, resourceProblem) {
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      if (connInfo.conn === conn) {
        if (resourceProblem) {
          this._backoffEndpoint(connInfo.inUseBy.folderId);
        }
        logic(this, 'releaseConnection', {
          folderId: connInfo.inUseBy.folderId,
          label: connInfo.inUseBy.label
        });
        connInfo.inUseBy = null;

         // We just freed up a connection, it may be appropriate to close it.
        this.maybeCloseUnusedConnections();
        return;
      }
    }
    logic(this, 'connectionMismatch');
  },

  shutdown: function(callback) {
    this._backoffEndpoint.shutdown();

    // - close all connections
    var liveConns = this._ownedConns.length;
    function connDead() {
      if (--liveConns === 0) {
        callback();
      }
    }
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      if (callback) {
        connInfo.inUseBy = { deathback: connDead };
        try {
          connInfo.conn.client.close();
        }
        catch (ex) {
          liveConns--;
        }
      }
      else {
        connInfo.conn.client.close();
      }
    }

    if (!liveConns && callback) {
      callback();
    }
  },

  checkAccount: function(listener) {
    logic(this, 'checkAccount_begin');
    this._makeConnection(function(err) {
      logic(this, 'checkAccount_end', { error: err });
      listener(err);
    }.bind(this), null, 'check');
  },

  //////////////////////////////////////////////////////////////////////////////

};

// XXX: Use mix.js when it lands in the streaming patch.
for (var k in properties) {
  Object.defineProperty(ImapAccount.prototype, k,
                        Object.getOwnPropertyDescriptor(properties, k));
}
