define(function(require) {

let a64 = require('../a64');

let utils = require('../utils');
let bsearchMaybeExists = utils.bsearchMaybeExists;
let bsearchForInsert = utils.bsearchForInsert;

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
  this._eventId = '';

  this._bound_onChange = this.onChange.bind(this);

  this.__deactivate();
}
FolderConversationsTOC.prototype = RefedResource.mix({
  __activate: function*() {
    let { idsWithDates, drainEvents, eventId } =
      yield this._db.loadFolderConversationIdsAndListen(this.folderId);

    this.idsWithDates = idsWithDates;
    this._eventId = eventId;
    drainEvents(this._bound_onChange);
    this._db.on(eventId, this._bound_onChange);
  },

  __deactivate: function() {
    this.idsWithDates = [];
    this._db.removeListener(this._eventId, this._bound_onChange);
  },

  onChange: function(change) {

  }
});

return FolderConversationsTOC;
});
