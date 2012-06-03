/**
 *
 **/

define(
  [
    'imap',
    'rdcommon/log',
    './a64',
    './imapdb',
    './imapslice',
    './util',
    'module',
    'exports'
  ],
  function(
    $imap,
    $log,
    $a64,
    $imapdb,
    $imapslice,
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
function ImapAccount(universe, accountId, credentials, connInfo, folderInfos,
                     dbConn,
                     _parentLog, existingProtoConn) {
  this.universe = universe;
  this.id = accountId;

  this._credentials = credentials;
  this._connInfo = connInfo;
  this._db = dbConn;

  this._ownedConns = [];
  this._LOG = LOGFAB.ImapAccount(this, _parentLog, this.id);

  if (existingProtoConn) {
    this._LOG.reuseConnection();
    this._ownedConns.push({
        conn: existingProtoConn,
        inUse: false,
        folderId: null,
      });
  }

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
   *   @param[lastFullFolderProbeAt DateMS]{
   *     When was the last time we went through our list of folders and got the
   *     unread count in each folder.
   *   }
   *   @param[capability String]{
   *     The post-login capability string from the server.
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
  this._meta = this._folderInfos.$meta;
  for (var folderId in folderInfos) {
    if (folderId[0] === '$')
      continue;
    var folderInfo = folderInfos[folderId];

    folderStorages[folderId] =
      new $imapslice.ImapFolderStorage(this, folderId, folderInfo, this._db,
                                       this._LOG);
    folderPubs.push(folderInfo.$meta);
  }
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
  _learnAboutFolder: function(name, path, type, delim) {
    var folderId = this.id + '/' + $a64.encodeInt(this._meta.nextFolderNum++);
    console.log('FOLDER', name, path, type);
    var folderInfo = this._folderInfos[folderId] = {
      $meta: {
        id: folderId,
        name: name,
        path: path,
        type: type,
        delim: delim,
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
      new $imapslice.ImapFolderStorage(this, folderId, folderInfo, this._db,
                                       this._LOG);

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
    if (this._deadFolderIds === null)
      this._deadFolderIds = [];
    this._deadFolderIds.push(folderId);
    folderStorage.youAreDeadCleanupAfterYourself();

    this.universe.__notifyRemovedFolder(this.id, folderMeta);
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
      delim = this._meta.rootDelim;
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
      // We need to re-derive the path
      var folderMeta = null;
      function walkBoxes(boxLevel, pathSoFar) {
        for (var boxName in boxLevel) {
          var box = boxLevel[boxName],
              boxPath = pathSoFar ? (pathSoFar + boxName) : boxName,
              type = self._determineFolderType(box, boxPath);
          folderMeta = self._learnAboutFolder(boxName, boxPath, type,
                                              box.delim);
        }
      }
      walkBoxes(boxesRoot, '');
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

  /**
   * Create a view slice on the messages in a folder, starting from the most
   * recent messages and synchronizing further as needed.
   */
  sliceFolderMessages: function(folderId, bridgeHandle) {
    var storage = this._folderStorages[folderId],
        slice = new $imapslice.ImapSlice(bridgeHandle, storage, this._LOG);

    storage.sliceOpenFromNow(slice);
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
      callback(reusableConnInfo.conn);
      return;
    }

    this._makeConnection(folderId, callback);
  },

  _makeConnection: function(folderId, callback) {
    this._LOG.createConnection(folderId);
    var opts = {
      hostname: this._connInfo.hostname,
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
    conn.on('close', function() {
      });
    conn.on('error', function(err) {
        // this hears about connection errors too
        console.warn('Connection error:', err);
      });
    conn.connect(function(err) {
      if (!err) {
        callback(conn);
      }
    });
  },

  __folderDoneWithConnection: function(folderId, conn) {
    // XXX detect if the connection is actually dead and in that case don't
    // reinsert it.
    for (var i = 0; i < this._ownedConns.length; i++) {
      var connInfo = this._ownedConns[i];
      if (connInfo.conn === conn) {
        connInfo.inUse = false;
        connInfo.folderId = null;
        // XXX this will trigger an expunge if not read-only...
        if (folderId)
          conn.closeBox(function() {});
        return;
      }
    }
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
    function walkBoxes(boxLevel, pathSoFar) {
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
          self._learnAboutFolder(boxName, path, type, box.delim);
        }

        if (box.children)
          walkBoxes(box.children, pathSoFar + boxName + box.delim);
      }
    }
    walkBoxes(boxesRoot, '');

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
    callback();
  },

  runOp: function(op, callback) {
    var methodName = '_do_' + op.type;
    if (!(methodName in this))
      throw new Error("Unsupported op: '" + op.type + "'");
    this[methodName](op, callback);
  },

  _do_append: function(op, callback) {
    var rawConn, self = this,
        folderMeta = this._folderInfos[op.folderId].$meta,
        iNextMessage = 0;
    function gotConn(conn) {
      rawConn = conn;
      rawConn.openBox(folderMeta.path, openedBox);
    }
    function openedBox(err, box) {
      if (err) {
        console.error('failure opening box to append message');
        done('unknown');
        return;
      }
      if (rawConn.hasCapability('MULTIAPPEND'))
        multiappend();
      else
        append();
    }
    function multiappend() {
      iNextMessage = op.messages.length;
      rawConn.multiappend(op.messages, appended);
    }
    function append() {
      var message = op.messages[iNextMessage++];
      rawConn.append(
        message.messageText,
        message, // (it will ignore messageText)
        appended);
    }
    function appended(err) {
      if (err) {
        console.error('failure appending message', err);
        done('unknown');
        return;
      }
      if (iNextMessage < op.messages.length)
        append();
      else
        done(null);
    }
    function done(errString) {
      if (rawConn) {
        self.__folderDoneWithConnection(op.folderId, rawConn);
        rawConn = null;
      }
      callback(errString);
    }

    this.__folderDemandsConnection(op.folderId, gotConn);
  },

  _do_modtags: function(op, callback) {
    var partitions = $imaputil.partitionMessagesByFolderId(op.messages, true);
    var rawConn, self = this,
        folderMeta = null, messages = null,
        iNextPartition = 0, modsToGo = 0;

    function gotConn(conn) {
      rawConn = conn;
      openNextFolder();
      rawConn.openBox(folderMeta.path, openedBox);
    }
    function openNextFolder() {
      if (iNextPartition >= partitions.length) {
        done(null);
        return;
      }

      var partition = partitions[iNextPartition++];
      folderMeta = self._folderInfos[partition.folderId].$meta;
      messages = partition.messages;
      rawConn.openBox(folderMeta.path, openedBox);
    }
    function openedBox(err, box) {
      if (err) {
        console.error('failure opening box to modify tags');
        done('unknown');
        return;
      }
      if (op.addTags) {
        modsToGo++;
        rawConn.addFlags(messages, op.addTags, tagsModded);
      }
      if (op.removeTags) {
        modsToGo++;
        rawConn.removeFlags(messages, op.removeTags, tagsModded);
      }
    }
    function tagsModded(err) {
      if (err) {
        console.error('failure modifying tags', err);
        done('unknown');
        return;
      }
      if (--modsToGo === 0)
        openNextFolder();
    }
    function done(errString) {
      if (rawConn) {
        self.__folderDoneWithConnection(folderMeta.id, rawConn);
        rawConn = null;
      }
      callback(errString);
    }

    this.__folderDemandsConnection(':modtags', gotConn);
  },
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
    },
    TEST_ONLY_events: {
      createFolder: { path: false },
      deleteFolder: { path: false },

      createConnection: { folderId: false },
      reuseConnection: {},
    },
    errors: {
      folderAlreadyHasConn: { folderId: false },
    },
  },
});

}); // end define
