define(function(require) {
'use strict';

const evt = require('evt');
const logic = require('logic');

const { bsearchForInsert } = require('../util');

const { encodeInt: encodeA64Int } = require('../a64');
const { decodeSpecificFolderIdFromFolderId } = require('../id_conversions');

const { engineFrontEndFolderMeta, engineHacks } = require('../engine_glue');

let FOLDER_TYPE_TO_SORT_PRIORITY = {
  account: 'a',
  inbox: 'c',
  starred: 'e',
  important: 'f',
  drafts: 'g',
  localdrafts: 'h',
  outbox: 'i',
  queue: 'j',
  sent: 'k',
  junk: 'l',
  trash: 'n',
  archive: 'p',
  normal: 'z',
  // nomail folders are annoying since they are basically just hierarchy,
  //  but they are also rare and should only happen amongst normal folders.
  nomail: 'z',
};

function strcmp(a, b) {
  if (a < b) {
    return -1;
  } else if (a > b) {
    return 1;
  } else {
    return 0;
  }
}

/**
 * Self-managed Folder TOC that owns the canonical list of folders for an
 * account.
 *
 * Each FoldersTOC is eternal.  You don't need to acquire or release it.
 *
 * Note: The back-end used to just order things by path.  And the front-end
 * ordered things by our crazy sort priority.  Now we use the sort priority here
 * in the back-end and expose that to the front-end too.
 */
function FoldersTOC({ db, accountDef, folders, dataOverlayManager }) {
  evt.Emitter.call(this);
  logic.defineScope(this, 'FoldersTOC');

  this.accountDef = accountDef;
  this.engineFolderMeta = engineFrontEndFolderMeta.get(accountDef.engine);
  this.engineHacks = engineHacks.get(accountDef.engine);
  this.accountId = accountDef.id;
  this._dataOverlayManager = dataOverlayManager;

  /**
   * Canonical folder state representation.  This is what goes in the database.
   * @type {Map<FolderId, FolderInfo>}
   */
  this.foldersById = this.itemsById = new Map();

  /**
   * Ordered list of the folders.
   */
  this.items = this.folders = [];
  /**
   * Parallel ordering array to items; the contents are the folder sort strings
   * corresponding to the folder at the same index.
   *
   * While we could stick the sort string in the FolderInfo, the strings can
   * get long and ugly and we don't want to worry about changes to the sort
   * ordering screwing things up on upgrade/downgrade/etc.  Plus, this is how
   * we did it in v1.
   */
  this.folderSortStrings = [];

  let nextFolderNum = 0;
  for (let folderInfo of folders) {
    this._addFolder(folderInfo);
    nextFolderNum =
      Math.max(
        nextFolderNum,
        decodeSpecificFolderIdFromFolderId(folderInfo.id) + 1);
  }

  // See `issueFolderId` for the sordid details.
  this._nextFolderNum = nextFolderNum;

  // TODO: on account deletion we should be removing these listeners, but this
  // is a relatively harmless leak given that account creation and deletion is
  // a relatively rare operation.
  db.on(`acct!${accountDef.id}!change`, this._onAccountChange.bind(this));
  db.on(
    `acct!${accountDef.id}!folders!tocChange`, this._onTOCChange.bind(this));

  dataOverlayManager.on(
    'accountCascadeToFolders', this._onAccountOverlayCascade.bind(this));
}
FoldersTOC.prototype = evt.mix({
  type: 'FoldersTOC',
  overlayNamespace: 'folders',

  // We don't care about who references us because we have the lifetime of the
  // universe.  (At least, unless our owning account gets deleted.)
  __acquire: function() {
    return Promise.resolve(this);
  },

  __release: function() {
    // nothing to do
  },

  /**
   * Someone needs to allocate folder id's (that are namespaced by the account
   * id), and we are it.  Using `_deriveNextFolderId`, we determine the high
   * specific folder id portion and convert it to a number and add one.
   *
   * There are other ways of doing this.  We used to store all folders in a
   * single per-account aggregate object with an explicit "meta" field.  Since
   * the folders are logically orthogonal and dealing with them independently
   * normalizes our handling of them, the meta field no longer had a home.  The
   * options were:
   * - This.  Rely on the fact that the folders are all in-memory all the time
   *   and so we can reliably choose an id without collision and can allocate
   *   id's in O(1) time following a one-off O(n) scan we were basically already
   *   doing.  The downside is that our "high water mark" is inherently not
   *   persisted, so if a folder is added and deleted and we restart and
   *   re-derive id's, we will reissue the id.  This really only matters to
   *   logging.
   * - Store the information in the account data which is also always-in-memory
   *   and therefore something we can manipulate using our atomicClobbers
   *   construct.  This is roughly what we do for account id allocation,
   *   except in that case it's sitting on the global config object.  I'm still
   *   not 100% happy with that, but the situation is somewhat different
   *   because:
   *   - The global config object is relatively boring and has very little in
   *     it.  Most settings are per-account.  This is relevant because it means
   *     that there is little chance for database triggers to be interested in
   *     the configuration.
   *   - Reuse of account id's is undesirable for paranoia reasons related to
   *     the database.  Also, there is useful debugging information in the
   *     account id's as they are directly correlated with user actions (but
   *     without having serious privacy implications.)  If a user reports a
   *     problem where logs show an extremely high account id, we know something
   *     very buggy is going on or the user may be a QA tester in disguise! ;)
   * - Store the information in some other data structure.  The best option
   *   would be an atomicClobber-able structure that just holds a lot of id's.
   *   This may still be the best way forward.  The worst option is a structure
   *   that is loaded on-demand and thus precludes atomic manipulations.  The
   *   ActiveSync implementation temporarily used its account-level sync-state
   *   since it already needed it for mapping purposes.  But this potentially
   *   could induce blocking against an online task if insufficiently careful
   *   (we like sync tasks to be able to hold their sync states exclusively
   *   while doing online things), so was not desirable.
   *
   * It's definitely okay to revisit this informed by time and implementation
   * regret.
   */
  issueFolderId: function() {
    return this.accountId + '.' + encodeA64Int(this._nextFolderNum++);
  },

  getAllItems: function() {
    return this.items;
  },

  /**
   * Make a folder sorting function that groups folders by account, puts the
   * account header first in that group, maps priorities using
   * FOLDER_TYPE_TO_SORT_PRIORITY, then sorts by path within that.
   *
   * This is largely necessitated by localeCompare being at the mercy of glibc's
   * locale database and failure to fallback to unicode code points for
   * comparison purposes.
   */
  _makeFolderSortString: function(folderInfo) {
    if (!folderInfo) {
      return '';
    }

    var parentFolderInfo = this.foldersById.get(folderInfo.parentId);
    return this._makeFolderSortString(parentFolderInfo) + '!' +
           FOLDER_TYPE_TO_SORT_PRIORITY[folderInfo.type] + '!' +
           folderInfo.name.toLocaleLowerCase();
  },

  /**
   * Some complex tasks may do things at an account granularity but which should
   * (potentially) be reported in the overlays of all folders.  In the interest
   * of simplifying the lives of those tasks
   */
  _onAccountOverlayCascade: function(accountId) {
    // This event is an unfiltered firehose; we have to filter down to our id.
    if (accountId === this.accountId) {
      for (let i = 0; i < this.items.length; i++) {
        let folder = this.items[i];
        this._dataOverlayManager.announceUpdatedOverlayData(
          this.overlayNamespace, folder.id);
      }
    }
  },

  /**
   * Keep up-to-date with account changes.  Note that while the accountDef
   * reference itself should never change (accountDefs are defined to be always
   * in-memory, etc.), we do need to be alerted when values change since we
   * propagate data to the folders.
   */
  _onAccountChange: function(/* accountId, accountDef */) {
    // We are also assuming the engine and engineFolderMeta can't change at
    // runtime without retracting and re-adding the account.  This is an
    // invariant, though.
    this._fakeFolderDataChanges();
  },

  /**
   * Pretend the selected folders changed (data-wise, not overlay-wise).
   */
  _fakeFolderDataChanges: function(filterFunc) {
    for (let i = 0; i < this.items.length; i++) {
      let folder = this.items[i];
      if (!filterFunc || filterFunc(folder)) {
        this.emit('change', this.folderInfoToWireRep(folder), i);
      }
    }
  },

  _onTOCChange: function(folderId, folderInfo, isNew) {
    if (isNew) {
      // - add
      this._addFolder(folderInfo);
    } else if (folderInfo) {
      // - change
      // object identity ensures folderInfo is already present.
      this.emit(
        'change',
        this.folderInfoToWireRep(folderInfo),
        this.items.indexOf(folderInfo));
    } else {
      // - remove
      this._removeFolderById(folderId);
    }
  },

  _addFolder: function(folderInfo) {
    let sortString = this._makeFolderSortString(folderInfo);
    let idx = bsearchForInsert(this.folderSortStrings, sortString, strcmp);
    this.items.splice(idx, 0, folderInfo);
    logic(this, 'addFolder',
          { id: folderInfo.id, index: idx, _folderInfo: folderInfo });
    this.folderSortStrings.splice(idx, 0, sortString);
    this.foldersById.set(folderInfo.id, folderInfo);

    this.emit('add', this.folderInfoToWireRep(folderInfo), idx);
  },

  _removeFolderById: function(id) {
    let folderInfo = this.foldersById.get(id);
    let idx = this.items.indexOf(folderInfo);
    logic(this, 'removeFolderById', { id: id, index: idx });
    if (!folderInfo || idx === -1) {
      throw new Error('the folder did not exist?');
    }
    this.foldersById.delete(id);
    this.items.splice(idx, 1);
    this.folderSortStrings.splice(idx, 1);
    this.emit('remove', id, idx);
  },

  /**
   * For cases like the sent folder or drafts folder where there is only one
   * true folder of this type, return that folder.  This supersedes our prior
   * use of getFirstFolderWithType whose semantics were less good.
   *
   * TODO: Actually have our logic not be the same as getFirstFolderWithType.
   */
  getCanonicalFolderByType: function(type) {
    return this.items.find(folder => folder.type === type) || null;
  },

  generatePersistenceInfo: function() {
    return this._foldersDbState;
  },

  /**
   * Generate the wire rep for a folder *belonging to this account*, mixing in
   * account engine details, and in the future, maybe other details too.
   */
  folderInfoToWireRep: function(folder) {
    let mixFromAccount;
    // If this account syncs on a per-account basis, spread the sync information
    // that sync_refresh stashed on the account.
    if (this.engineFolderMeta.syncGranularity === 'account' &&
        this.accountDef.syncInfo) {
      let syncInfo = this.accountDef.syncInfo;
      mixFromAccount = {
        lastSuccessfulSyncAt: syncInfo.lastSuccessfulSyncAt,
        lastAttemptedSyncAt: syncInfo.lastAttemptedSyncAt,
        failedSyncsSinceLastSuccessfulSync:
          syncInfo.failedSyncsSinceLastSuccessfulSync
      };
    }

    return Object.assign(
      {},
      folder,
      this.engineFolderMeta,
      // engine hack contributions.
      {
        engineSaysUnselectable:
          this.engineHacks.unselectableFolderTypes.has(folder.type)
      },
      mixFromAccount
    );
  }
});

return FoldersTOC;
});
