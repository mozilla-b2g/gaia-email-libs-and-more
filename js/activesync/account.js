/**
 * Implements the ActiveSync protocol for Hotmail and Exchange.
 **/

define(
  [
    'logic',
    '../a64',
    '../accountmixins',
    '../mailslice',
    '../searchfilter',
    // We potentially create the synthetic inbox while offline, so this can't be
    // lazy-loaded.
    'activesync/codepages/FolderHierarchy',
    './folder',
    './jobs',
    '../util',
    '../db/folder_info_rep',
    'module',
    'require',
    'exports'
  ],
  function(
    logic,
    $a64,
    $acctmixins,
    $mailslice,
    $searchfilter,
    $FolderHierarchy,
    $asfolder,
    $asjobs,
    $util,
    $folder_info,
    $module,
    require,
    exports
  ) {
'use strict';

// Lazy loaded vars.
var $wbxml, $asproto, ASCP;

var $FolderTypes = $FolderHierarchy.Enums.Type;
var DEFAULT_TIMEOUT_MS = exports.DEFAULT_TIMEOUT_MS = 30 * 1000;

/**
 * Randomly create a unique device id so that multiple devices can independently
 * synchronize without interfering with each other.  Our only goals are to avoid
 * needlessly providing fingerprintable data and avoid collisions with other
 * instances of ourself.  We're using Math.random over crypto.getRandomValues
 * since node does not have the latter right now and predictable values aren't
 * a concern.
 *
 * @return {String} An multi-character ASCII alphanumeric sequence.  (Probably
     10 or 11 digits.)
 */
exports.makeUniqueDeviceId = function() {
  return Math.random().toString(36).substr(2);
};

/**
 * Prototype-helper to wrap a method in a call to withConnection.  This exists
 * largely for historical reasons.  All actual lazy-loading happens within
 * withConnection.
 */
function lazyConnection(cbIndex, fn, failString) {
  return function lazyRun() {
    var args = Array.slice(arguments),
        errback = args[cbIndex],
        self = this;

    this.withConnection(errback, function () {
      fn.apply(self, args);
    }, failString);
  };
}

function ActiveSyncAccount(universe, accountDef, foldersTOC, dbConn,
                           receiveProtoConn) {
  this.universe = universe;
  this.id = accountDef.id;
  this.accountDef = accountDef;

  // Transparent upgrade; allocate a device-id if we don't have one.  By doing
  // this we avoid forcing the user to manually re-create the account.  And the
  // current migration system would throw away any saved drafts, which is not
  // desirable.  The common thing in all cases is that we will need to re-sync
  // the folders.
  // XXX remove this upgrade logic when we next compel a version upgrade (and do
  // so safely.)
  if (!accountDef.connInfo.deviceId) {
    accountDef.connInfo.deviceId = exports.makeUniqueDeviceId();
  }

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


  // Immediately ensure that we have any required local-only folders,
  // as those can be created even while offline.
  this.ensureEssentialOfflineFolders();

  // Mix in any fields common to all accounts.
  $acctmixins.accountConstructorMixin.call(
    this, /* receivePiece = */ this, /* sendPiece = */ this);
}

exports.Account = exports.ActiveSyncAccount = ActiveSyncAccount;
ActiveSyncAccount.prototype = {
  type: 'activesync',
  supportsServerFolders: true,
  toString: function asa_toString() {
    return '[ActiveSyncAccount: ' + this.id + ']';
  },

  /**
   * Manages connecting, and wiring up initial connection if it is not
   * initialized yet.
   */
  withConnection: function (errback, callback, failString) {
    // lazy load our dependencies if they haven't already been fetched.  This
    // occurs regardless of whether we have a connection already or not.  We
    // do this because the connection may have been passed-in to us as a
    // leftover of the account creation process.
    if (!$wbxml) {
      require(['wbxml', 'activesync/protocol', 'activesync/codepages'],
              function (_wbxml, _asproto, _ASCP) {
        $wbxml = _wbxml;
        $asproto = _asproto;
        ASCP = _ASCP;

        this.withConnection(errback, callback, failString);
      }.bind(this));
      return;
    }

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
        callback();
      }.bind(this));
    } else {
      callback();
    }
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

  syncFolderList: lazyConnection(0, function asa_syncFolderList(callback) {
    var account = this;

    var fh = ASCP.FolderHierarchy.Tags;
    var w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(fh.FolderSync)
       .tag(fh.SyncKey, this.meta.syncKey)
     .etag();

    this.conn.postCommand(w, function(aError, aResponse) {
      if (aError) {
        account._reportErrorIfNecessary(aError);
        callback(aError);
        return;
      }
      var e = new $wbxml.EventParser();
      var deferredAddedFolders = [];

      e.addEventListener([fh.FolderSync, fh.SyncKey], function(node) {
        account.meta.syncKey = node.children[0].textContent;
      });

      e.addEventListener([fh.FolderSync, fh.Changes, [fh.Add, fh.Delete]],
                         function(node) {
        var folder = {};
        for (let child of node.children) {
          folder[child.localTagName] = child.children[0].textContent;
        }

        if (node.tag === fh.Add) {
          if (!account._addedFolder(folder.ServerId, folder.ParentId,
                                    folder.DisplayName, folder.Type)) {
            deferredAddedFolders.push(folder);
          }
        }
        else {
          account._deletedFolder(folder.ServerId);
        }
      });

      try {
        e.run(aResponse);
      }
      catch (ex) {
        console.error('Error parsing FolderSync response:', ex, '\n',
                      ex.stack);
        callback('unknown');
        return;
      }

      // It's possible we got some folders in an inconvenient order (i.e. child
      // folders before their parents). Keep trying to add folders until we're
      // done.
      while (deferredAddedFolders.length) {
        var moreDeferredAddedFolders = [];
        for (let folder of deferredAddedFolders) {
          if (!account._addedFolder(folder.ServerId, folder.ParentId,
                                    folder.DisplayName, folder.Type)) {
            moreDeferredAddedFolders.push(folder);
          }
        }
        if (moreDeferredAddedFolders.length === deferredAddedFolders.length) {
          throw new Error('got some orphaned folders');
        }
        deferredAddedFolders = moreDeferredAddedFolders;
      }

      // Once we've synchonized the folder list, kick off another job
      // to check that we have all essential online folders. Once that
      // completes, we'll check to make sure our offline-only folders
      // (localdrafts, outbox) are in the right place according to
      // where this server stores other built-in folders.
      account.ensureEssentialOnlineFolders();
      account.normalizeFolderHierarchy();

      console.log('Synced folder list');
      callback && callback(null);
    });
  }),

  // Map folder type numbers from ActiveSync to Gaia's types
  _folderTypes: {
     1: 'normal', // Generic
     2: 'inbox',  // DefaultInbox
     3: 'drafts', // DefaultDrafts
     4: 'trash',  // DefaultDeleted
     5: 'sent',   // DefaultSent
     6: 'normal', // DefaultOutbox
    12: 'normal', // Mail
  },

  /**
   * List of known junk folder names, taken from browserbox.js, and used to
   * infer folders that are junk folders based on their name since there is
   * no enumerated type representing junk folders.
   */
  _junkFolderNames: [
    'bulk mail', 'correo no deseado', 'courrier indésirable', 'istenmeyen',
    'istenmeyen e-posta', 'junk', 'levélszemét', 'nevyžiadaná pošta',
    'nevyžádaná pošta', 'no deseado', 'posta indesiderata', 'pourriel',
    'roskaposti', 'skräppost', 'spam', 'spamowanie', 'søppelpost',
    'thư rác', 'спам', 'דואר זבל', 'الرسائل العشوائية', 'هرزنامه', 'สแปม',
    '垃圾郵件', '垃圾邮件', '垃圾電郵'],

  /**
   * Update the internal database and notify the appropriate listeners when we
   * discover a new folder.
   *
   * @param {string} serverId A GUID representing the new folder
   * @param {string} parentServerId A GUID representing the parent folder, or
   *  '0' if this is a root-level folder
   * @param {string} displayName The display name for the new folder
   * @param {string} typeNum A numeric value representing the new folder's type,
   *   corresponding to the mapping in _folderTypes above
   * @param {string} forceType Force a string folder type for this folder.
   *   Used for synthetic folders like localdrafts.
   * @param {boolean} suppressNotification (optional) if true, don't notify any
   *   listeners of this addition
   * @return {object} the folderMeta if we added the folder, true if we don't
   *   care about this kind of folder, or null if we need to wait until later
   *   (e.g. if we haven't added the folder's parent yet)
   */
  _addedFolder: function(serverId, parentServerId, displayName, typeNum,
                         forceType) {
    if (!forceType && !(typeNum in this._folderTypes)) {
      return true; // Not a folder type we care about.
    }

    var path = displayName;
    var parentFolderId = null;
    var depth = 0;
    if (parentServerId !== '0') {
      var parentInfo = this.getFolderByServerId(parentServerId);
      // No parent yet?  Return null and the add will get deferred.
      if (!parent) {
        return null;
      }
      parentFolderId = parentInfo.id;
      path = parentInfo.path + '/' + path;
      depth = parentInfo.depth + 1;
    }

    var useFolderType = this._folderTypes[typeNum];
    // Check if this looks like a junk folder based on its name/path.  (There
    // is no type for junk/spam folders, so this regrettably must be inferred
    // from the name.  At least for hotmail.com/outlook.com, it appears that
    // the name is "Junk" regardless of the locale in which the account is
    // created, but our current datapoint is one account created using the
    // Spanish locale.
    //
    // In order to avoid bad detections, we assume that the junk folder is
    // at the top-level or is only nested one level deep.
    if (depth < 2) {
      var normalizedName = displayName.toLowerCase();
      if (this._junkFolderNames.indexOf(normalizedName) !== -1) {
        useFolderType = 'junk';
      }
    }
    if (forceType) {
      useFolderType = forceType;
    }

    // Handle sentinel Inbox.
    if (typeNum === $FolderTypes.DefaultInbox) {
      var existingInboxMeta = this.getFirstFolderWithType('inbox');
      if (existingInboxMeta) {
        // Update everything about the folder meta.
        existingInboxMeta.serverId = serverId;
        existingInboxMeta.name = displayName;
        existingInboxMeta.path = path;
        existingInboxMeta.depth = depth;
        return existingInboxMeta;
      }
    }

    var folderId = this.id + '.' + $a64.encodeInt(this.meta.nextFolderNum++);
    var folderInfo = $folder_info.makeFolderMeta({
      id: folderId,
      serverId: serverId,
      name: displayName,
      type: useFolderType,
      path: path,
      parentId: parentFolderId,
      depth: depth,
      lastSyncedAt: 0
    });

    this.foldersTOC.addFolder(folderInfo);

    return folderInfo;
  },

  /**
   * Update the TOC in response to the changes in our folders.
   *
   * @param {string} serverId A GUID representing the deleted folder
   */
  _deletedFolder: function asa__deletedFolder(serverId) {
    var folderInfo = this.getFolderByServerId(serverId);
    if (folderInfo) {
      this.foldersTOC.removeFolderById(folderInfo.id);
    }
  },

  /**
   * Create a folder that is the child/descendant of the given parent folder.
   * If no parent folder id is provided, we attempt to create a root folder.
   *
   * NOTE: This function is currently unused.  It might have been used for
   * testing at some point.  It will be used again someday but should not be
   * assumed to actually work when that day comes.
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
  createFolder: lazyConnection(3, function asa_createFolder(parentFolderId,
                                                      folderName,
                                                      containOnlyOtherFolders,
                                                      callback) {
    var account = this;

    var parentFolderServerId = parentFolderId ?
      this._folderInfos[parentFolderId] : '0';

    var fh = ASCP.FolderHierarchy.Tags;
    var fhStatus = ASCP.FolderHierarchy.Enums.Status;
    var folderType = ASCP.FolderHierarchy.Enums.Type.Mail;

    var w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(fh.FolderCreate)
       .tag(fh.SyncKey, this.meta.syncKey)
       .tag(fh.ParentId, parentFolderServerId)
       .tag(fh.DisplayName, folderName)
       .tag(fh.Type, folderType)
     .etag();

    this.conn.postCommand(w, function(aError, aResponse) {
      account._reportErrorIfNecessary(aError);

      var e = new $wbxml.EventParser();
      var status, serverId;

      e.addEventListener([fh.FolderCreate, fh.Status], function(node) {
        status = node.children[0].textContent;
      });
      e.addEventListener([fh.FolderCreate, fh.SyncKey], function(node) {
        account.meta.syncKey = node.children[0].textContent;
      });
      e.addEventListener([fh.FolderCreate, fh.ServerId], function(node) {
        serverId = node.children[0].textContent;
      });

      try {
        e.run(aResponse);
      }
      catch (ex) {
        console.error('Error parsing FolderCreate response:', ex, '\n',
                      ex.stack);
        callback('unknown');
        return;
      }

      if (status === fhStatus.Success) {
        var folderMeta = account._addedFolder(serverId, parentFolderServerId,
                                              folderName, folderType);
        callback(null, folderMeta);
      }
      else if (status === fhStatus.FolderExists) {
        callback('already-exists');
      }
      else {
        callback('unknown');
      }
    });
  }),

  /**
   * Delete an existing folder WITHOUT ANY ABILITY TO UNDO IT.  Current UX
   * does not desire this, but the unit tests do.
   *
   * Callback is like the createFolder one, why not.
   */
  deleteFolder: lazyConnection(1, function asa_deleteFolder(folderId,
                                                            callback) {
    var account = this;

    var folderMeta = this._folderInfos[folderId].$meta;

    var fh = ASCP.FolderHierarchy.Tags;
    var fhStatus = ASCP.FolderHierarchy.Enums.Status;

    var w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(fh.FolderDelete)
       .tag(fh.SyncKey, this.meta.syncKey)
       .tag(fh.ServerId, folderMeta.serverId)
     .etag();

    this.conn.postCommand(w, function(aError, aResponse) {
      account._reportErrorIfNecessary(aError);

      var e = new $wbxml.EventParser();
      var status;

      e.addEventListener([fh.FolderDelete, fh.Status], function(node) {
        status = node.children[0].textContent;
      });
      e.addEventListener([fh.FolderDelete, fh.SyncKey], function(node) {
        account.meta.syncKey = node.children[0].textContent;
      });

      try {

        e.run(aResponse);
      }
      catch (ex) {
        console.error('Error parsing FolderDelete response:', ex, '\n',
                      ex.stack);
        callback('unknown');
        return;
      }

      if (status === fhStatus.Success) {
        account._deletedFolder(folderMeta.serverId);
        callback(null, folderMeta);
      }
      else {
        callback('unknown');
      }
    });
  }),

  sendMessage: lazyConnection(1, function asa_sendMessage(composer, callback) {
    var account = this;

    // we want the bcc included because that's how we tell the server the bcc
    // results.
    composer.withMessageBlob({ includeBcc: true }, function(mimeBlob) {
      // ActiveSync 14.0 has a completely different API for sending email. Make
      // sure we format things the right way.
      if (this.conn.currentVersion.gte('14.0')) {
        var cm = ASCP.ComposeMail.Tags;
        var w = new $wbxml.Writer('1.3', 1, 'UTF-8', null, 'blob');
        w.stag(cm.SendMail)
           // The ClientId is defined to be for duplicate messages suppression
           // and does not need to have any uniqueness constraints apart from
           // not being similar to (recently sent) messages by this client.
           .tag(cm.ClientId, Date.now().toString()+'@mozgaia')
           .tag(cm.SaveInSentItems)
           .stag(cm.Mime)
             .opaque(mimeBlob)
           .etag()
         .etag();

        this.conn.postCommand(w, function(aError, aResponse) {
          if (aError) {
            account._reportErrorIfNecessary(aError);
            console.error(aError);
            callback('unknown');
            return;
          }

          if (aResponse === null) {
            console.log('Sent message successfully!');
            callback(null);
          }
          else {
            console.error('Error sending message. XML dump follows:\n' +
                          aResponse.dump());
            callback('unknown');
          }
        }, /* aExtraParams = */ null, /* aExtraHeaders = */ null,
          /* aProgressCallback = */ function() {
          // Keep holding the wakelock as we continue sending.
          composer.renewSmartWakeLock('ActiveSync XHR Progress');
        });
      }
      else { // ActiveSync 12.x and lower
        this.conn.postData('SendMail', 'message/rfc822', mimeBlob,
                           function(aError, aResponse) {
          if (aError) {
            account._reportErrorIfNecessary(aError);
            console.error(aError);
            callback('unknown');
            return;
          }

          console.log('Sent message successfully!');
          callback(null);
        }, { SaveInSent: 'T' }, /* aExtraHeaders = */ null,
          /* aProgressCallback = */ function() {
          // Keep holding the wakelock as we continue sending.
          composer.renewSmartWakeLock('ActiveSync XHR Progress');
        });
      }
    }.bind(this));
  }),

  /**
   * Ensure that local-only folders exist. This runs synchronously
   * before we sync the folder list with the server. Ideally, these
   * folders should reside in a proper place in the folder hierarchy,
   * which may differ between servers depending on whether the
   * account's other folders live underneath the inbox or as
   * top-level-folders. But since moving folders is easy and doesn't
   * really affect the backend, we'll just ensure they exist here, and
   * fix up their hierarchical location when syncing the folder list.
   */
  ensureEssentialOfflineFolders: function() {
    // On folder type numbers: While there are enum values for outbox
    // and drafts, they represent server-side default folders, not the
    // local folders we create for ourselves, so they must be created
    // with an unknown typeNum.
    [{
      type: 'inbox',
      displayName: 'Inbox', // Intentionally title-case.
      typeNum: $FolderTypes.DefaultInbox,
    }, {
      type: 'outbox',
      displayName: 'outbox',
      typeNum: $FolderTypes.Unknown, // There is no "local outbox" typeNum.
    }, {
      type: 'localdrafts',
      displayName: 'localdrafts',
      typeNum: $FolderTypes.Unknown, // There is no "localdrafts" typeNum.
    }].forEach(function(data) {
      if (!this.getFirstFolderWithType(data.type)) {
        this._addedFolder(
          /* serverId: */ null,
          /* parentServerId: */ '0',
          /* displayName: */ data.displayName,
          /* typeNum: */ data.typeNum,
          /* forceType: */ data.type);
      }
    }, this);
  },

  /**
   * Kick off jobs to create essential folders (sent, trash) if
   * necessary. These folders should be created on both the client and
   * the server; contrast with `ensureEssentialOfflineFolders`.
   *
   * TODO: Support localizing all automatically named e-mail folders
   * regardless of the origin locale.
   * Relevant bugs: <https://bugzil.la/905869>, <https://bugzil.la/905878>.
   *
   * @param {function} callback
   *   Called when all ops have run.
   */
  ensureEssentialOnlineFolders: function(callback) {
    // Our ActiveSync implementation currently assumes that all
    // ActiveSync servers always come with Sent and Trash folders. If
    // that assumption proves false, we'd add them here like IMAP.
    callback && callback();
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

  upgradeFolderStoragesIfNeeded: $acctmixins.upgradeFolderStoragesIfNeeded,
  runOp: $acctmixins.runOp,
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

}); // end define
