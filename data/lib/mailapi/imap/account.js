/**
 *
 **/

define(
  [
    'rdcommon/log',
    '../a64',
    '../allback',
    '../errbackoff',
    '../mailslice',
    '../searchfilter',
    '../util',
    '../composite/incoming',
    './folder',
    './jobs',
    'module',
    'require',
    'exports'
  ],
  function(
    $log,
    $a64,
    $allback,
    $errbackoff,
    $mailslice,
    $searchfilter,
    $util,
    incoming,
    $imapfolder,
    $imapjobs,
    $module,
    require,
    exports
  ) {
var bsearchForInsert = $util.bsearchForInsert;
var allbackMaker = $allback.allbackMaker;
var CompositeIncomingAccount = incoming.CompositeIncomingAccount;

function cmpFolderPubPath(a, b) {
  return a.path.localeCompare(b.path);
}

/**
 * Account object, root of all interaction with servers.
 *
 * Passwords are currently held in cleartext with the rest of the data.  Ideally
 * we would like them to be stored in some type of keyring coupled to the TCP
 * API in such a way that we never know the API.  Se a vida e.
 *
 */
function ImapAccount(universe, compositeAccount, accountId, credentials,
                     connInfo, folderInfos,
                     dbConn,
                     _parentLog, existingProtoConn) {
  this._LOG = LOGFAB.ImapAccount(this, _parentLog, accountId);
  CompositeIncomingAccount.apply(
      this, [$imapfolder.ImapFolderSyncer].concat(Array.slice(arguments)));

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
  this._backoffEndpoint = $errbackoff.createEndpoint('imap:' + this.id, this,
                                                     this._LOG);

  if (existingProtoConn)
    this._reuseConnection(existingProtoConn);

  this.tzOffset = compositeAccount.accountDef.tzOffset;
  this._jobDriver = new $imapjobs.ImapJobDriver(
                          this, this._folderInfos.$mutationState, this._LOG);

  /**
   * Flag to allow us to avoid calling closeBox to close a folder.  This avoids
   * expunging deleted messages.
   */
  this._TEST_doNotCloseFolder = false;
}

exports.Account = exports.ImapAccount = ImapAccount;
ImapAccount.prototype = Object.create(CompositeIncomingAccount.prototype);
var properties = {
  type: 'imap',
  supportsServerFolders: true,
  toString: function() {
    return '[ImapAccount: ' + this.id + ']';
  },

  get isGmail() {
    return this.meta.capability.indexOf('X-GM-EXT-1') !== -1;
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
      window.setZeroTimeout(deathback);
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
    if (this._demandedConns.length > 1)
      return;

    // - try and reuse an existing connection
    if (this._allocateExistingConnection())
      return;

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
    if (!this._demandedConns.length)
      return false;
    var demandInfo = this._demandedConns[0];

    var reusableConnInfo = null;
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      // It's concerning if the folder already has a connection...
      if (demandInfo.folderId && connInfo.folderId === demandInfo.folderId)
        this._LOG.folderAlreadyHasConn(demandInfo.folderId);

      if (connInfo.inUseBy)
        continue;

      connInfo.inUseBy = demandInfo;
      this._demandedConns.shift();
      this._LOG.reuseConnection(demandInfo.folderId, demandInfo.label);
      demandInfo.callback(connInfo.conn);
      return true;
    }

    return false;
  },

  /**
   * Close all connections that aren't currently in use.
   */
  closeUnusedConnections: function() {
    for (var i = this._ownedConns.length - 1; i >= 0; i--) {
      var connInfo = this._ownedConns[i];
      if (connInfo.inUseBy)
        continue;
      // this eats all future notifications, so we need to splice...
      connInfo.conn.die();
      this._ownedConns.splice(i, 1);
      this._LOG.deadConnection();
    }
  },

  _makeConnectionIfPossible: function() {
    if (this._ownedConns.length >= this._maxConnsAllowed) {
      this._LOG.maximumConnsNoNew();
      return;
    }
    if (this._pendingConn)
      return;

    this._pendingConn = true;
    var boundMakeConnection = this._makeConnection.bind(this);
    this._backoffEndpoint.scheduleConnectAttempt(boundMakeConnection);
  },

  _makeConnection: function(listener, whyFolderId, whyLabel) {
    // Mark a pending connection synchronously; the require call will not return
    // until at least the next turn of the event loop.
    this._pendingConn = true;
    // Dynamically load the probe/imap code to speed up startup.
    require(['imap', './probe'], function ($imap, $imapprobe) {
      this._LOG.createConnection(whyFolderId, whyLabel);
      var opts = {
        host: this._connInfo.hostname,
        port: this._connInfo.port,
        crypto: this._connInfo.crypto,

        username: this._credentials.username,
        password: this._credentials.password,

        blacklistedCapabilities: this._connInfo.blacklistedCapabilities,
      };
      if (this._LOG) opts._logParent = this._LOG;
      var conn = this._pendingConn = new $imap.ImapConnection(opts);
      var connectCallbackTriggered = false;
      // The login callback should get invoked in all cases, but a recent code
      // inspection for the prober suggested that there may be some cases where
      // things might fall-through, so let's just convert them.  We need some
      // type of handler since imap.js currently calls the login callback and
      // then the 'error' handler, generating an error if there is no error
      // handler.
      conn.on('error', function(err) {
        if (!connectCallbackTriggered)
          loginCb(err);
      });
      var loginCb;
      conn.connect(loginCb = function(err) {
        connectCallbackTriggered = true;
        this._pendingConn = null;
        if (err) {
          var normErr = $imapprobe.normalizeError(err);
          console.error('Connect error:', normErr.name, 'formal:', err, 'on',
                        this._connInfo.hostname, this._connInfo.port);
          if (normErr.reportProblem)
            this.universe.__reportAccountProblem(this.compositeAccount,
                                                 normErr.name);


          if (listener)
            listener(normErr.name);
          conn.die();

          // track this failure for backoff purposes
          if (normErr.retry) {
            if (this._backoffEndpoint.noteConnectFailureMaybeRetry(
                                        normErr.reachable))
              this._makeConnectionIfPossible();
            else
              this._killDieOnConnectFailureDemands();
          }
          else {
            this._backoffEndpoint.noteBrokenConnection();
            this._killDieOnConnectFailureDemands();
          }
        }
        else {
          this._bindConnectionDeathHandlers(conn);
          this._backoffEndpoint.noteConnectSuccess();
          this._ownedConns.push({
            conn: conn,
            inUseBy: null,
          });
          this._allocateExistingConnection();
          if (listener)
            listener(null);
          // Keep opening connections if there is more work to do
          // (and possible).
          if (this._demandedConns.length)
            this._makeConnectionIfPossible();
        }
      }.bind(this));
    }.bind(this));
  },

  /**
   * Treat a connection that came from the IMAP prober as a connection we
   * created ourselves.
   */
  _reuseConnection: function(existingProtoConn) {
    // We don't want the probe being kept alive and we certainly don't need its
    // listeners.
    existingProtoConn.removeAllListeners();
    this._ownedConns.push({
        conn: existingProtoConn,
        inUseBy: null,
      });
    this._bindConnectionDeathHandlers(existingProtoConn);
  },

  _bindConnectionDeathHandlers: function(conn) {
    // on close, stop tracking the connection in our list of live connections
    conn.on('close', function() {
      for (var i = 0; i < this._ownedConns.length; i++) {
        var connInfo = this._ownedConns[i];
        if (connInfo.conn === conn) {
          this._LOG.deadConnection(connInfo.inUseBy &&
                                   connInfo.inUseBy.folderId);
          if (connInfo.inUseBy && connInfo.inUseBy.deathback)
            connInfo.inUseBy.deathback(conn);
          connInfo.inUseBy = null;
          this._ownedConns.splice(i, 1);
          return;
        }
      }
      this._LOG.unknownDeadConnection();
    }.bind(this));
    conn.on('error', function(err) {
      this._LOG.connectionError(err);
      // this hears about connection errors too
      console.warn('Conn steady error:', err, 'on',
                   this._connInfo.hostname, this._connInfo.port);
    }.bind(this));
  },

  __folderDoneWithConnection: function(conn, closeFolder, resourceProblem) {
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      if (connInfo.conn === conn) {
        if (resourceProblem)
          this._backoffEndpoint(connInfo.inUseBy.folderId);
        this._LOG.releaseConnection(connInfo.inUseBy.folderId,
                                    connInfo.inUseBy.label);
        connInfo.inUseBy = null;
        // (this will trigger an expunge if not read-only...)
        if (closeFolder && !resourceProblem && !this._TEST_doNotCloseFolder)
          conn.closeBox(function() {});
        return;
      }
    }
    this._LOG.connectionMismatch();
  },

  //////////////////////////////////////////////////////////////////////////////
  // Folder synchronization

  /**
   * Helper in conjunction with `_syncFolderComputeDeltas` for use by the
   * syncFolderList operation/job.  The op is on the hook for the connection's
   * lifecycle.
   */
  _syncFolderList: function(conn, callback) {
    conn.getBoxes(this._syncFolderComputeDeltas.bind(this, conn, callback));
  },
  _determineFolderType: function(box, path, conn) {
    var type = null;
    // NoSelect trumps everything.
    if (box.attribs.indexOf('NOSELECT') !== -1) {
      type = 'nomail';
    }
    else {
      // Standards-ish:
      // - special-use: http://tools.ietf.org/html/rfc6154
      //   IANA registrations:
      //   http://www.iana.org/assignments/imap4-list-extended
      // - xlist:
      //   https://developers.google.com/google-apps/gmail/imap_extensions

      // Process the attribs for goodness.
      for (var i = 0; i < box.attribs.length; i++) {
        switch (box.attribs[i]) {
          // TODO: split the 'all' cases into their own type!
          case 'ALL': // special-use
          case 'ALLMAIL': // xlist
          case 'ARCHIVE': // special-use
            type = 'archive';
            break;
          case 'DRAFTS': // special-use xlist
            type = 'drafts';
            break;
          case 'FLAGGED': // special-use
            type = 'starred';
            break;
          case 'IMPORTANT': // (undocumented) xlist
            type = 'important';
            break;
          case 'INBOX': // xlist
            type = 'inbox';
            break;
          case 'JUNK': // special-use
            type = 'junk';
            break;
          case 'SENT': // special-use xlist
            type = 'sent';
            break;
          case 'SPAM': // xlist
            type = 'junk';
            break;
          case 'STARRED': // xlist
            type = 'starred';
            break;

          case 'TRASH': // special-use xlist
            type = 'trash';
            break;

          case 'HASCHILDREN': // 3348
          case 'HASNOCHILDREN': // 3348

          // - standard bits we don't care about
          case 'MARKED': // 3501
          case 'UNMARKED': // 3501
          case 'NOINFERIORS': // 3501
            // XXX use noinferiors to prohibit folder creation under it.
          // NOSELECT

          default:
        }
      }

      // heuristic based type assignment based on the name
      if (!type) {
        // ensure that we treat folders at the root, see bug 854128
        var personalNS = conn.namespaces.personal;
        var prefix = personalNS.length ? personalNS[0].prefix : '';
        var isAtNamespaceRoot = path === (prefix + box.displayName);
        // If our name is our path, we are at the absolute root of the tree.
        // This will be the case for INBOX even if there is a namespace.
        if (isAtNamespaceRoot || path === box.displayName) {
          switch (box.displayName.toUpperCase()) {
            case 'DRAFT':
            case 'DRAFTS':
              type = 'drafts';
              break;
            case 'INBOX':
              // Inbox is special; the path needs to case-insensitively match.
              if (path.toUpperCase() === 'INBOX')
                type = 'inbox';
              break;
            // Yahoo provides "Bulk Mail" for yahoo.fr.
            case 'BULK MAIL':
            case 'JUNK':
            case 'SPAM':
              type = 'junk';
              break;
            case 'SENT':
              type = 'sent';
              break;
            case 'TRASH':
              type = 'trash';
              break;
            // This currently only exists for consistency with Thunderbird, but
            // may become useful in the future when we need an outbox.
            case 'UNSENT MESSAGES':
              type = 'queue';
              break;
          }
	}
      }

      if (!type)
        type = 'normal';
    }
    return type;
  },
  _syncFolderComputeDeltas: function(conn, callback, err, boxesRoot) {
    var self = this;
    if (err) {
      callback(err);
      return;
    }

    // - build a map of known existing folders
    var folderPubsByPath = {};
    var folderPub;
    for (var iFolder = 0; iFolder < this.folders.length; iFolder++) {
      folderPub = this.folders[iFolder];
      folderPubsByPath[folderPub.path] = folderPub;
    }

    // - walk the boxes
    function walkBoxes(boxLevel, pathSoFar, pathDepth, parentId) {
      for (var boxName in boxLevel) {
        var box = boxLevel[boxName], meta,
            path = pathSoFar ? (pathSoFar + boxName) : boxName,
            folderId;

        // - normalize jerk-moves
        var type = self._determineFolderType(box, path, conn);
        // gmail finds it amusing to give us the localized name/path of its
        // inbox, but still expects us to ask for it as INBOX.
        if (type === 'inbox')
          path = 'INBOX';

        // - already known folder
        if (folderPubsByPath.hasOwnProperty(path)) {
          // Because we speculatively create the Inbox, both its display name
          // and delimiter may be incorrect and need to be updated.
          meta = folderPubsByPath[path];
          meta.name = box.displayName;
          meta.delim = box.delim;

          // mark it with true to show that we've seen it.
          folderPubsByPath[path] = true;
        }
        // - new to us!
        else {
          meta = self._learnAboutFolder(box.displayName, path, parentId, type,
                                        box.delim, pathDepth);
        }

        if (box.children)
          walkBoxes(box.children, pathSoFar + boxName + box.delim,
                    pathDepth + 1, meta.id);
      }
    }
    walkBoxes(boxesRoot, '', 0, null);

    // - detect deleted folders
    // track dead folder id's so we can issue a
    var deadFolderIds = [];
    for (var folderPath in folderPubsByPath) {
      folderPub = folderPubsByPath[folderPath];
      // (skip those we found above)
      if (folderPub === true)
        continue;
      // Never delete our localdrafts folder.
      if (folderPub.type === 'localdrafts')
        continue;
      // It must have gotten deleted!
      this._forgetFolder(folderPub.id);
    }

    // Add a localdrafts folder if we don't have one.
    var localDrafts = this.getFirstFolderWithType('localdrafts');
    if (!localDrafts) {
      // Try and add the folder next to the existing drafts folder, or the
      // sent folder if there is no drafts folder.  Otherwise we must have an
      // inbox and we want to live under that.
      var sibling = this.getFirstFolderWithType('drafts') ||
                    this.getFirstFolderWithType('sent');
      var parentId = sibling ? sibling.parentId
                             : this.getFirstFolderWithType('inbox').id;
      // parentId will be null if we are already top-level
      var parentFolder;
      if (parentId) {
        parentFolder = this._folderInfos[parentId].$meta;
      }
      else {
        parentFolder = {
          path: '', delim: '', depth: -1
        };
      }
      var localDraftPath = parentFolder.path + parentFolder.delim +
            'localdrafts';
      // Since this is a synthetic folder; we just directly choose the name
      // that our l10n mapping will transform.
      this._learnAboutFolder('localdrafts', localDraftPath,  parentId,
                             'localdrafts', parentFolder.delim,
                             parentFolder.depth + 1);
    }

    callback(null);
  },

  /**
   * Asynchronously save the sent message to the sent folder, if applicable.
   * This should only be called once the SMTP send has completed.
   *
   * If non-gmail, append a bcc-including version of the message into the sent
   * folder.  For gmail, the SMTP server automatically copies the message into
   * the sent folder so we don't need to do this.
   *
   * There are several notable limitations with the current implementation:
   * - We do not write a copy of the message into the sent folder locally, so
   *   the message must be downloaded/synchronized for the user to see it.
   * - The operation to append the message does not get persisted to disk, so
   *   in the event the app crashes or is closed, a copy of the message will
   *   not end up in the sent folder.  This has always been the emergent
   *   phenomenon for IMAP, except previously we would persist the operation
   *   and then mark it moot at 'check' time.  Our new technique of not saving
   *   the operation is preferable for disk space reasons.  (NB: We could
   *   persist it, but the composite Blob we build would be flattened which
   *   could generate an I/O storm, cause temporary double-storage use, etc.)
   */
  saveSentMessage: function(composer) {
    // (gmail automatically copies the message into the sent folder; we don't
    // have to do anything)
    if (this.isGmail) {
      return;
    }

    composer.withMessageBlob({ includeBcc: true }, function(blob) {
      var message = {
        messageText: blob,
        // do not specify date; let the server use its own timestamping
        // since we want the approximate value of 'now' anyways.
        flags: ['Seen'],
      };

      var sentFolder = this.getFirstFolderWithType('sent');
      if (sentFolder) {
        this.universe.appendMessages(sentFolder.id,
                                     [message]);
      }
    }.bind(this));
  },

  shutdown: function(callback) {
    CompositeIncomingAccount.prototype.shutdownFolders.call(this);

    this._backoffEndpoint.shutdown();

    // - close all connections
    var liveConns = this._ownedConns.length;
    function connDead() {
      if (--liveConns === 0)
        callback();
    }
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      if (callback) {
        connInfo.inUseBy = { deathback: connDead };
        try {
          connInfo.conn.logout();
        }
        catch (ex) {
          liveConns--;
        }
      }
      else {
        connInfo.conn.die();
      }
    }

    this._LOG.__die();
    if (!liveConns && callback)
      callback();
  },

  checkAccount: function(listener) {
    this._LOG.checkAccount_begin(null);
    this._makeConnection(function(err) {
      this._LOG.checkAccount_end(err);
      listener(err);
    }.bind(this), null, 'check');
  },

  accountDeleted: function() {
    this._alive = false;
    this.shutdown();
  },


  //////////////////////////////////////////////////////////////////////////////

};

// XXX: Use mix.js when it lands in the streaming patch.
for (var k in properties) {
  Object.defineProperty(ImapAccount.prototype, k,
                        Object.getOwnPropertyDescriptor(properties, k));
}

// Share the log configuration with composite, since we desire general
// parity between IMAP and POP3 for simplicity when possible.
var LOGFAB = exports.LOGFAB = $log.register($module, {
  ImapAccount: incoming.LOGFAB_DEFINITION.CompositeIncomingAccount
});

}); // end define
