/**
 *
 **/

define(
  [
    'imap',
    'rdcommon/log',
    '../a64',
    '../mailslice',
    './slice',
    './jobs',
    '../util',
    'module',
    'exports'
  ],
  function(
    $imap,
    $log,
    $a64,
    $mailslice,
    $imapslice,
    $imapjobs,
    $imaputil,
    $module,
    exports
  ) {
const bsearchForInsert = $imaputil.bsearchForInsert;

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
  this.universe = universe;
  this.compositeAccount = compositeAccount;
  this.id = accountId;

  this._credentials = credentials;
  this._connInfo = connInfo;
  this._db = dbConn;

  this._ownedConns = [];
  this._LOG = LOGFAB.ImapAccount(this, _parentLog, this.id);

  this._jobDriver = new $imapjobs.ImapJobDriver(this);

  if (existingProtoConn)
    this._reuseConnection(existingProtoConn);

  // Yes, the pluralization is suspect, but unambiguous.
  /** @dictof[@key[FolderId] @value[ImapFolderStorage] */
  var folderStorages = this._folderStorages = {};
  /** @dictof[@key[FolderId] @value[ImapFolderMeta] */
  var folderPubs = this.folders = [];

  /**
   * The list of dead folder id's that we need to nuke the storage for when
   * we next save our account status to the database.
   */
  this._deadFolderIds = null;

  /**
   * The canonical folderInfo object we persist to the database.
   */
  this._folderInfos = folderInfos;
  /**
   * @dict[
   *   @param[nextFolderNum Number]{
   *     The next numeric folder number to be allocated.
   *   }
   *   @param[nextMutationNum Number]{
   *     The next mutation id to be allocated.
   *   }
   *   @param[lastFullFolderProbeAt DateMS]{
   *     When was the last time we went through our list of folders and got the
   *     unread count in each folder.
   *   }
   *   @param[capability @listof[String]]{
   *     The post-login capabilities from the server.
   *   }
   *   @param[rootDelim String]{
   *     The root hierarchy delimiter.  It is possible for servers to not
   *     support hierarchies, but we just declare that those servers are not
   *     acceptable for use.
   *   }
   * ]{
   *   Meta-information about the account derived from probing the account.
   *   This information gets flushed on database upgrades.
   * }
   */
  this.meta = this._folderInfos.$meta;
  /**
   * @listof[SerializedMutation]{
   *   The list of recently issued mutations against us.  Mutations are added
   *   as soon as they are requested and remain until evicted based on a hard
   *   numeric limit.  The limit is driven by our unit tests rather than our
   *   UI which currently only allows a maximum of 1 (high-level) undo.  The
   *   status of whether the mutation has been run is tracked on the mutation
   *   but does not affect its presence or position in the list.
   *
   *   Right now, the `MailUniverse` is in charge of this and we just are a
   *   convenient place to stash the data.
   * }
   */
  this.mutations = this._folderInfos.$mutations;
  for (var folderId in folderInfos) {
    if (folderId[0] === '$')
      continue;
    var folderInfo = folderInfos[folderId];

    folderStorages[folderId] =
      new $mailslice.FolderStorage(this, folderId, folderInfo, this._db,
                                   $imapslice.ImapFolderConn, this._LOG);
    folderPubs.push(folderInfo.$meta);
  }
  this.folders.sort(function(a, b) {
    return a.path.localeCompare(b.path);
  });
}
exports.ImapAccount = ImapAccount;
ImapAccount.prototype = {
  type: 'imap',
  toString: function() {
    return '[ImapAccount: ' + this.id + ']';
  },

  /**
   * Make a given folder known to us, creating state tracking instances, etc.
   */
  _learnAboutFolder: function(name, path, type, delim, depth) {
    var folderId = this.id + '/' + $a64.encodeInt(this.meta.nextFolderNum++);
    var folderInfo = this._folderInfos[folderId] = {
      $meta: {
        id: folderId,
        name: name,
        path: path,
        type: type,
        delim: delim,
        depth: depth
      },
      $impl: {
        nextHeaderBlock: 0,
        nextBodyBlock: 0,
      },
      accuracy: [],
      headerBlocks: [],
      bodyBlocks: [],
    };
    this._folderStorages[folderId] =
      new $mailslice.FolderStorage(this, folderId, folderInfo, this._db,
                                   $imapslice.ImapFolderConn, this._LOG);

    var folderMeta = folderInfo.$meta;
    var idx = bsearchForInsert(this.folders, folderMeta, cmpFolderPubPath);
    this.folders.splice(idx, 0, folderMeta);

    this.universe.__notifyAddedFolder(this.id, folderMeta);
    return folderMeta;
  },

  _forgetFolder: function(folderId) {
    var folderInfo = this._folderInfos[folderId],
        folderMeta = folderInfo.$meta;
    delete this._folderInfos[folderId];
    var folderStorage = this._folderStorages[folderId];
    delete this._folderStorages[folderId];
    var idx = this.folders.indexOf(folderMeta);
    this.folders.splice(idx, 1);
    if (this._deadFolderIds === null)
      this._deadFolderIds = [];
    this._deadFolderIds.push(folderId);
    folderStorage.youAreDeadCleanupAfterYourself();

    this.universe.__notifyRemovedFolder(this.id, folderMeta);
  },

  /**
   * We are being told that a synchronization pass completed, and that we may
   * want to consider persisting our state.
   */
  __checkpointSyncCompleted: function() {
    this.saveAccountState();
  },

  /**
   * Save the state of this account to the database.  This entails updating all
   * of our highly-volatile state (folderInfos which contains counters, accuracy
   * structures, and our block info structures) as well as any dirty blocks.
   *
   * This should be entirely coherent because the structured clone should occur
   * synchronously during this call, but it's important to keep in mind that if
   * that ever ends up not being the case that we need to cause mutating
   * operations to defer until after that snapshot has occurred.
   */
  saveAccountState: function(reuseTrans) {
    var perFolderStuff = [], self = this;
    for (var iFolder = 0; iFolder < this.folders.length; iFolder++) {
      var folderPub = this.folders[iFolder],
          folderStorage = this._folderStorages[folderPub.id],
          folderStuff = folderStorage.generatePersistenceInfo();
      if (folderStuff)
        perFolderStuff.push(folderStuff);
    }
    this._LOG.saveAccountState_begin();
    var trans = this._db.saveAccountFolderStates(
      this.id, this._folderInfos, perFolderStuff,
      this._deadFolderIds,
      function stateSaved() {
        self._LOG.saveAccountState_end();
      },
      reuseTrans);
    this._deadFolderIds = null;
    return trans;
  },

  /**
   * Create a folder that is the child/descendant of the given parent folder.
   * If no parent folder id is provided, we attempt to create a root folder.
   *
   * @args[
   *   @param[parentFolderId String]
   *   @param[folderName]
   *   @param[containOnlyOtherFolders Boolean]{
   *     Should this folder only contain other folders (and no messages)?
   *     On some servers/backends, mail-bearing folders may not be able to
   *     create sub-folders, in which case one would have to pass this.
   *   }
   *   @param[callback @func[
   *     @args[
   *       @param[error @oneof[
   *         @case[null]{
   *           No error, the folder got created and everything is awesome.
   *         }
   *         @case['offline']{
   *           We are offline and can't create the folder.
   *         }
   *         @case['already-exists']{
   *           The folder appears to already exist.
   *         }
   *         @case['unknown']{
   *           It didn't work and we don't have a better reason.
   *         }
   *       ]]
   *       @param[folderMeta ImapFolderMeta]{
   *         The meta-information for the folder.
   *       }
   *     ]
   *   ]]{
   *   }
   * ]
   */
  createFolder: function(parentFolderId, folderName, containOnlyOtherFolders,
                         callback) {
    var path, delim;
    if (parentFolderId) {
      if (!this._folderInfos.hasOwnProperty(parentFolderId))
        throw new Error("No such folder: " + parentFolderId);
      var parentFolder = this._folderInfos[parentFolderId];
      delim = parentFolder.path;
      path = parentFolder.path + delim;
    }
    else {
      path = '';
      delim = this.meta.rootDelim;
    }
    if (typeof(folderName) === 'string')
      path += folderName;
    else
      path += folderName.join(delim);
    if (containOnlyOtherFolders)
      path += delim;

    if (!this.universe.online) {
      callback('offline');
      return;
    }

    var rawConn = null, self = this;
    function gotConn(conn) {
      // create the box
      rawConn = conn;
      rawConn.addBox(path, addBoxCallback);
    }
    function addBoxCallback(err) {
      if (err) {
        console.error('Error creating box:', err);
        // XXX implement the already-exists check...
        done('unknown');
        return;
      }
      // Do a list on the folder so that we get the right attributes and any
      // magical case normalization performed by the server gets observed by
      // us.
      rawConn.getBoxes('', path, gotBoxes);
    }
    function gotBoxes(err, boxesRoot) {
      if (err) {
        console.error('Error looking up box:', err);
        done('unknown');
        return;
      }
      // We need to re-derive the path.  The hierarchy will only be that
      // required for our new folder, so we traverse all children and create
      // the leaf-node when we see it.
      var folderMeta = null;
      function walkBoxes(boxLevel, pathSoFar, pathDepth) {
        for (var boxName in boxLevel) {
          var box = boxLevel[boxName],
              boxPath = pathSoFar ? (pathSoFar + boxName) : boxName;
          if (box.children) {
            walkBoxes(box.children, boxPath + box.delim, pathDepth + 1);
          }
          else {
            var type = self._determineFolderType(box, boxPath);
            folderMeta = self._learnAboutFolder(boxName, boxPath, type,
                                                box.delim, pathDepth);
          }
        }
      }
      walkBoxes(boxesRoot, '', 0);
      if (folderMeta)
        done(null, folderMeta);
      else
        done('unknown');
    }
    function done(errString, folderMeta) {
      if (rawConn) {
        self.__folderDoneWithConnection(null, rawConn);
        rawConn = null;
      }
      if (!errString)
        self._LOG.createFolder(path);
      if (callback)
        callback(errString, folderMeta);
    }
    this.__folderDemandsConnection(':createFolder', gotConn);
  },

  /**
   * Delete an existing folder WITHOUT ANY ABILITY TO UNDO IT.  Current UX
   * does not desire this, but the unit tests do.
   *
   * Callback is like the createFolder one, why not.
   */
  deleteFolder: function(folderId, callback) {
    if (!this._folderInfos.hasOwnProperty(folderId))
      throw new Error("No such folder: " + folderId);

    if (!this.universe.online) {
      callback('offline');
      return;
    }

    var folderMeta = this._folderInfos[folderId].$meta;

    var rawConn = null, self = this;
    function gotConn(conn) {
      rawConn = conn;
      rawConn.delBox(folderMeta.path, deletionCallback);
    }
    function deletionCallback(err) {
      if (err)
        done('unknown');
      else
        done(null);
    }
    function done(errString) {
      if (rawConn) {
        self.__folderDoneWithConnection(null, rawConn);
        rawConn = null;
      }
      if (!errString) {
        self._LOG.deleteFolder(folderMeta.path);
        self._forgetFolder(folderId);
      }
      if (callback)
        callback(errString, folderMeta);
    }
    this.__folderDemandsConnection(':deleteFolder', gotConn);
  },

  getFolderStorageForFolderId: function(folderId) {
    if (this._folderStorages.hasOwnProperty(folderId))
      return this._folderStorages[folderId];
    throw new Error('No folder with id: ' + folderId);
  },

  getFolderStorageForMessageSuid: function(messageSuid) {
    var folderId = messageSuid.substring(0, messageSuid.lastIndexOf('/'));
    if (this._folderStorages.hasOwnProperty(folderId))
      return this._folderStorages[folderId];
    throw new Error('No folder with id: ' + folderId);
  },

  /**
   * Create a view slice on the messages in a folder, starting from the most
   * recent messages and synchronizing further as needed.
   */
  sliceFolderMessages: function(folderId, bridgeHandle) {
    var storage = this._folderStorages[folderId],
        slice = new $mailslice.MailSlice(bridgeHandle, storage, this._LOG);

    storage.sliceOpenFromNow(slice);
  },

  shutdown: function() {
    // - kill all folder storages (for their loggers)
    for (var iFolder = 0; iFolder < this.folders.length; iFolder++) {
      var folderPub = this.folders[iFolder],
          folderStorage = this._folderStorages[folderPub.id];
      folderStorage.shutdown();
    }

    // - close all connections
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      connInfo.conn.die();
    }

    this._LOG.__die();
  },

  get numActiveConns() {
    return this._ownedConns.length;
  },

  /**
   * Mechanism for an `ImapFolderConn` to request an IMAP protocol connection.
   * This is to potentially support some type of (bounded) connection pooling
   * like Thunderbird uses.  The rationale is that many servers cap the number
   * of connections we are allowed to maintain, plus it's hard to justify
   * locally tying up those resources.  (Thunderbird has more need of watching
   * multiple folders than ourselves, bu we may still want to synchronize a
   * bunch of folders in parallel for latency reasons.)
   *
   * The provided connection will *not* be in the requested folder; it's up to
   * the folder connection to enter the folder.
   *
   * @args[
   *   @param[folderId #:optional FolderId]{
   *     The folder id of the folder that will be using the connection.  If
   *     it's not a folder but some task, then pass a string prefixed with
   *     a colon and a human readable string to explain the task.
   *   }
   *   @param[callback]{
   *     The callback to invoke once the connection has been established.  If
   *     there is a connection present in the reuse pool, this may be invoked
   *     immediately.
   *   }
   * ]
   */
  __folderDemandsConnection: function(folderId, callback) {
    var reusableConnInfo = null;
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      if (!connInfo.inUse)
        reusableConnInfo = connInfo;
      // It's concerning if the folder already has a connection...
      if (folderId && connInfo.folderId === folderId) {
        this._LOG.folderAlreadyHasConn(folderId);
      }
    }

    if (reusableConnInfo) {
      reusableConnInfo.inUse = true;
      reusableConnInfo.folderId = folderId;
      this._LOG.reuseConnection(folderId);
      callback(reusableConnInfo.conn);
      return;
    }

    this._makeConnection(folderId, callback);
  },

  checkAccount: function(callback) {
    var self = this;
    this._makeConnection(
      ':check',
      function success(conn) {
        self.__folderDoneWithConnection(null, conn);
        callback(null);
      },
      function badness(err) {
        callback(err);
      });
  },

  _makeConnection: function(folderId, callback, errback) {
    this._LOG.createConnection(folderId);
    var opts = {
      host: this._connInfo.hostname,
      port: this._connInfo.port,
      crypto: this._connInfo.crypto,

      username: this._credentials.username,
      password: this._credentials.password,
    };
    if (this._LOG) opts._logParent = this._LOG;
    var conn = new $imap.ImapConnection(opts);
    this._ownedConns.push({
        conn: conn,
        inUse: true,
        folderId: folderId,
      });
    this._bindConnectionDeathHandlers(conn);
    conn.connect(function(err) {
      if (err) {
        var errName;
        switch (err.type) {
          // error-codes as defined in `MailApi.js` for tryToCreateAccount
          case 'NO':
          case 'no':
            errName = 'bad-user-or-pass';
            this.universe.__reportAccountProblem(this.compositeAccount,
                                                 errName);
            break;
          case 'timeout':
            errName = 'unresponsive-server';
            break;
          default:
            errName = 'unknown';
            break;
        }
        console.error('Connect error:', errName, 'formal:', err, 'on',
                      this._connInfo.hostname, this._connInfo.port);
        if (errback)
          errback(errName);
        conn.die();
      }
      else {
        callback(conn);
      }
    }.bind(this));
  },

  _reuseConnection: function(existingProtoConn) {
    // We don't want the probe being kept alive and we certainly don't need its
    // listeners.
    existingProtoConn.removeAllListeners();
    this._ownedConns.push({
        conn: existingProtoConn,
        inUse: false,
        folderId: null,
      });
    this._bindConnectionDeathHandlers(existingProtoConn);
  },

  _bindConnectionDeathHandlers: function(conn) {
    // on close, stop tracking the connection in our list of live connections
    conn.on('close', function() {
      for (var i = 0; i < this._ownedConns.length; i++) {
        var connInfo = this._ownedConns[i];
        if (connInfo.conn === conn) {
          this._LOG.deadConnection(connInfo.folderId);
          this._ownedConns.splice(i, 1);
          return;
        }
      }
    }.bind(this));
    conn.on('error', function(err) {
      // this hears about connection errors too
      console.warn('Conn steady error:', err, 'on',
                   this._connInfo.hostname, this._connInfo.port);
    }.bind(this));
  },

  __folderDoneWithConnection: function(folderId, conn) {
    // XXX detect if the connection is actually dead and in that case don't
    // reinsert it.
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      if (connInfo.conn === conn) {
        connInfo.inUse = false;
        connInfo.folderId = null;
        this._LOG.releaseConnection(folderId);
        // XXX this will trigger an expunge if not read-only...
        if (folderId)
          conn.closeBox(function() {});
        return;
      }
    }
    this._LOG.connectionMismatch(folderId);
  },

  syncFolderList: function(callback) {
    var self = this;
    this.__folderDemandsConnection(null, function(conn) {
      conn.getBoxes(self._syncFolderComputeDeltas.bind(self, conn, callback));
    });
  },
  _determineFolderType: function(box, path) {
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
        switch (path.toUpperCase()) {
          case 'DRAFT':
          case 'DRAFTS':
            type = 'drafts';
            break;
          case 'INBOX':
            type = 'inbox';
            break;
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
      // XXX need to deal with transient failure states
      this.__folderDoneWithConnection(null, conn);
      callback();
      return;
    }

    // - build a map of known existing folders
    var folderPubsByPath = {}, folderPub;
    for (var iFolder = 0; iFolder < this.folders.length; iFolder++) {
      folderPub = this.folders[iFolder];
      folderPubsByPath[folderPub.path] = folderPub;
    }

    // - walk the boxes
    function walkBoxes(boxLevel, pathSoFar, pathDepth) {
      for (var boxName in boxLevel) {
        var box = boxLevel[boxName],
            path = pathSoFar ? (pathSoFar + boxName) : boxName;

        // - already known folder
        if (folderPubsByPath.hasOwnProperty(path)) {
          // mark it with true to show that we've seen it.
          folderPubsByPath = true;
        }
        // - new to us!
        else {
          var type = self._determineFolderType(box, path);
          self._learnAboutFolder(boxName, path, type, box.delim, pathDepth);
        }

        if (box.children)
          walkBoxes(box.children, pathSoFar + boxName + box.delim,
                    pathDepth + 1);
      }
    }
    walkBoxes(boxesRoot, '', 0);

    // - detect deleted folders
    // track dead folder id's so we can issue a
    var deadFolderIds = [];
    for (var folderPath in folderPubsByPath) {
      folderPub = folderPubsByPath[folderPath];
      // (skip those we found above)
      if (folderPub === true)
        continue;
      // It must have gotten deleted!
      this._forgetFolder(folderPub.id);
    }

    this.__folderDoneWithConnection(null, conn);
    // be sure to save our state now that we are up-to-date on this.
    this.saveAccountState();
    callback();
  },

  /**
   * @args[
   *   @param[op MailOp]
   *   @param[mode @oneof[
   *     @case['local_do']{
   *       Apply the mutation locally to our database rep.
   *     }
   *     @case['check']{
   *       Check if the manipulation has been performed on the server.  There
   *       is no need to perform a local check because there is no way our
   *       database can be inconsistent in its view of this.
   *     }
   *     @case['do']{
   *       Perform the manipulation on the server.
   *     }
   *     @case['local_undo']{
   *       Undo the mutation locally.
   *     }
   *     @case['undo']{
   *       Undo the mutation on the server.
   *     }
   *   ]]
   *   @param[callback @func[
   *     @args[
   *       @param[error @oneof[String null]]
   *     ]
   *   ]]
   *   }
   * ]
   */
  runOp: function(op, mode, callback) {
    var methodName = mode + '_' + op.type, self = this,
        isLocal = (mode === 'local_do' || mode === 'local_undo');

    if (!(methodName in this._jobDriver))
      throw new Error("Unsupported op: '" + op.type + "' (mode: " + mode + ")");

    if (!isLocal)
      op.status = mode + 'ing';

    if (callback) {
      this._LOG.runOp_begin(mode, op.type, null);
      this._jobDriver[methodName](op, function(error, resultIfAny,
                                               accountSaveSuggested) {
        self._LOG.runOp_end(mode, op.type, error);
        if (!isLocal)
          op.status = mode + 'ne';
        callback(error, resultIfAny, accountSaveSuggested);
      });
    }
    else {
      this._LOG.runOp_begin(mode, op.type, null);
      var rval = this._jobDriver[methodName](op);
      if (!isLocal)
        op.status = mode + 'ne';
      this._LOG.runOp_end(mode, op.type, rval);
    }
  },

  // NB: this is not final mutation logic; it needs to be more friendly to
  // ImapFolderConn's.  See _do_modtags which is being cleaned up...
};

/**
 * While gmail deserves major props for providing any IMAP interface, everyone
 * is much better off if we treat it specially.  EVENTUALLY.
 */
function GmailAccount() {
}
GmailAccount.prototype = {
  type: 'gmail-imap',

};

var LOGFAB = exports.LOGFAB = $log.register($module, {
  ImapAccount: {
    type: $log.ACCOUNT,
    events: {
      createFolder: {},
      deleteFolder: {},

      createConnection: {},
      reuseConnection: {},
      releaseConnection: {},
      deadConnection: {},
      connectionMismatch: {},
    },
    TEST_ONLY_events: {
      createFolder: { path: false },
      deleteFolder: { path: false },

      createConnection: { folderId: false },
      reuseConnection: { folderId: false },
      releaseConnection: { folderId: false },
      deadConnection: { folderId: false },
      connectionMismatch: { folderId: false },
    },
    errors: {
      folderAlreadyHasConn: { folderId: false },
    },
    asyncJobs: {
      runOp: { mode: true, type: true, error: false, op: false },
      saveAccountState: {},
    },
    TEST_ONLY_asyncJobs: {
    },
  },
});

}); // end define
