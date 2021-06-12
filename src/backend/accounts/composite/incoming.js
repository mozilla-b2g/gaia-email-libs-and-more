import $acctmixins from '../../accountmixins';

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
export function CompositeIncomingAccount(
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
  this._engineData = this.accountDef.engineData;
  this._db = dbConn;

  this.foldersTOC = foldersTOC;
  // this is owned by the TOC.  Do not mutate!
  this.folders = this.foldersTOC.items;
}
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
    console.log('endpoint state change:', state);
    /*
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
    */
  },
};
