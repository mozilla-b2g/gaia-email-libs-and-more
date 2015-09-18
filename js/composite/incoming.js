define(function(require, exports) {
'use strict';

let log = require('rdcommon/log');
let $acctmixins = require('../accountmixins');


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
      connInfo, foldersTOC, dbConn/*, existingProtoConn */) {
  // our logic scope is defined by our subclass

  this.universe = universe;
  this.compositeAccount = compositeAccount;
  this.id = accountId;
  this.accountDef = compositeAccount.accountDef;
  this.enabled = true;
  this._alive = true;
  this._credentials = credentials;
  this._connInfo = connInfo;
  this._engineDetails = this.accountDef.engineDetails;
  this._db = dbConn;

  this.foldersTOC = foldersTOC;
  // this is owned by the TOC.  Do not mutate!
  this.folders = this.foldersTOC.items;
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
      default:
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
      checkAccount: { error: null },
      runOp: { mode: true, type: true, error: true, op: false },
      saveAccountState: { reason: true, folderSaveCount: true },
    },
    TEST_ONLY_asyncJobs: {
    },
  },
};
}); // end define
