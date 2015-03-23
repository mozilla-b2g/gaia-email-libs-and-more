define(function(require) {

let a64 = require('../a64');
let RefedResource = require('../refed_resource');
let compareMsgIds = a64.cmpUI64;

function folderConversationComparator(a, b) {

}

/**
 * Backs view-slices listing the conversations in a folder.
 *
 * The current approach is that at activation time we load the entirety of the
 * ordered conversation
 */
function FolderConversationsTOC(db, folderId) {
  RefedResource.call(this);
  this._db = db;
  this.folderId = folderId;

  this.
  this._bound_onChanges = this.onChanges.bind(this);

  this.__deactivate();
}
FolderConversationsTOC.prototype = RefedResource.mix({
  __activate: function*() {
    let { idsWithDates, drainEvents } =
      yield this._db.loadFolderConversationIdsAndListen(this.folderId);

    this.idsWithDates = idsWithDates;
    drainEvents(this._bound_onChanges);
    this._db.on('fldr!' + this.folderId + )
  },

  __deactivate: function() {
    this.idsWithDates = [];
  },

  onChanges: function(change) {

  }
});

return FolderConversationsTOC;
});
