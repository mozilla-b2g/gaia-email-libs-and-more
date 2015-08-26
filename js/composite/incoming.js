define(function(require, exports, module) {
'use strict';

let log = require('rdcommon/log');
let $a64 = require('../a64');
let $acctmixins = require('../accountmixins');
let $mailslice = require('../mailslice');
let $folder_info = require('../db/folder_info_rep');


/**
 * A base class for IMAP and POP accounts.
 *
 * A lot of the functionality related to handling folders,
 * orchestrating jobs, etc., is common to both IMAP and POP accounts.
 * This class factors out the common functionality, allowing the
 * ImapAccount and Pop3Account classes to only provide
 * protocol-specific code.
 *
 * @param {Class} FolderSyncer The class to instantiate for folder sync.
 *
 * The rest of the parameters match those passed to Pop3Account and
 * ImapAccount.
 */
function CompositeIncomingAccount(
      universe, compositeAccount, accountId, credentials,
      connInfo, foldersTOC, dbConn, existingProtoConn) {
  // our logic scope is defined by our subclass

  this.universe = universe;
  this.compositeAccount = compositeAccount;
  this.id = accountId;
  this.accountDef = compositeAccount.accountDef;
  this.enabled = true;
  this._alive = true;
  this._credentials = credentials;
  this._connInfo = connInfo;
  this._db = dbConn;

  this.foldersTOC = foldersTOC;
  // this is owned by the TOC.  Do not mutate!
  this.folders = this.foldersTOC.items;

  /**
   * @dict[
   *   @param[nextFolderNum Number]{
   *     The next numeric folder number to be allocated.
   *   }
   *   @param[nextMutationNum Number]{
   *     The next mutation id to be allocated.
   *   }
   *   @param[lastFolderSyncAt DateMS]{
   *     When was the last time we ran `syncFolderList`?
   *   }
   *   @param[capability @listof[String]]{
   *     The post-login capabilities from the server.
   *   }
   *   @param[overflowMap @dictof[
   *     @key[uidl String]
   *     @value[@dict[
   *       @key[size Number]
   *     ]]
   *   ]]{
   *     The list of messages that will NOT be downloaded by a sync
   *     automatically, but instead need to be fetched with a "Download
   *     more messages..." operation. (POP3 only.)
   *   }
   *   @param[uidlMap @dictof[
   *     @key[uidl String]
   *     @value[headerID String]
   *   ]]{
   *     A mapping of UIDLs to message header IDs. (POP3 only.)
   *   }
   * ]{
   *   Meta-information about the account derived from probing the account.
   *   This information gets flushed on database upgrades.
   * }
   */
  this.meta = foldersTOC.meta;

  // Ensure we have an inbox.  This is a folder that must exist with a standard
  // name, so we can create it without talking to the server.
  var inboxFolder = this.getFirstFolderWithType('inbox');
  if (!inboxFolder) {
    this._learnAboutFolder(
      'INBOX', 'INBOX', 'INBOX', null, 'inbox', '/', 0, true);
  }
}
exports.CompositeIncomingAccount = CompositeIncomingAccount;
CompositeIncomingAccount.prototype = {
  ////////////////////////////////////////////////////////////////
  // ACCOUNT OVERRIDES
  runOp: $acctmixins.runOp,
  getFirstFolderWithType: $acctmixins.getFirstFolderWithType,
  getFolderByPath: $acctmixins.getFolderByPath,
  saveAccountState: $acctmixins.saveAccountState,
  runAfterSaves: $acctmixins.runAfterSaves,

  /**
   * Make a given folder known to us, creating state tracking instances, etc.
   *
   * @param {Boolean} suppressNotification
   *   Don't report this folder to subscribed slices.  This is used in cases
   *   where the account has not been made visible to the front-end yet and/or
   *   syncFolderList hasn't yet run, but something subscribed to the "all
   *   accounts" unified folder slice could end up seeing something before it
   *   should.  This is a ret-con'ed comment, so maybe do some auditing before
   *   adding new call-sites that use this, especially if it's not used for
   *   offline-only folders at account creation/app startup.
   */
  _learnAboutFolder: function(name, path, serverPath, parentId, type, delim,
                              depth) {
    let folderId = this.id + '.' + $a64.encodeInt(this.meta.nextFolderNum++);
    let folderInfo =
      $folder_info.makeFolderMeta({
        id: folderId,
        name,
        type,
        path,
        serverPath,
        parentId,
        delim,
        depth,
        lastSyncedAt: 0
      });

    this.foldersTOC.addFolder(folderInfo);

    return folderInfo;
  },

  _forgetFolder: function(folderId) {
    this.foldersTOC.removeFolderById(folderId);
  },

  /**
   * We receive this notification from our _backoffEndpoint.
   */
  onEndpointStateChange: function(state) {
    switch (state) {
      case 'healthy':
        this.universe.__removeAccountProblem(this.compositeAccount,
                                             'connection', 'incoming');
        break;
      case 'unreachable':
      case 'broken':
        this.universe.__reportAccountProblem(this.compositeAccount,
                                             'connection', 'incoming');
        break;
    }
  },
};

exports.LOGFAB_DEFINITION = {
  CompositeIncomingAccount: {
    type: log.ACCOUNT,
    events: {
      createFolder: {},
      deleteFolder: {},
      recreateFolder: { id: false },

      createConnection: {},
      reuseConnection: {},
      releaseConnection: {},
      deadConnection: { why: true },
      unknownDeadConnection: {},
      connectionMismatch: {},

      /**
       * XXX: this is really an error/warning, but to make the logging less
       * confusing, treat it as an event.
       */
      accountDeleted: { where: false },

      /**
       * The maximum connection limit has been reached, we are intentionally
       * not creating an additional one.
       */
      maximumConnsNoNew: {},
    },
    TEST_ONLY_events: {
      deleteFolder: { path: false },

      createConnection: { label: false },
      reuseConnection: { label: false },
      releaseConnection: { folderId: false, label: false },
      deadConnection: { folder: false },
      connectionMismatch: {},
    },
    errors: {
      connectionError: {},
      folderAlreadyHasConn: { folderId: false },
      opError: { mode: false, type: false, ex: log.EXCEPTION },
    },
    asyncJobs: {
      checkAccount: { err: null },
      runOp: { mode: true, type: true, error: true, op: false },
      saveAccountState: { reason: true, folderSaveCount: true },
    },
    TEST_ONLY_asyncJobs: {
    },
  },
};

}); // end define
