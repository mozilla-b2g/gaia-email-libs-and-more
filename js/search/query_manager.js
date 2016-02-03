define(function(require) {
'use strict';

const DirectFolderQuery = require('./query/direct_folder_query');

/**
 * Abstraction for all persistent database queries.
 *
 */
function QueryManager({ db }) {
  this._db = db;
}
QueryManager.prototype = {
  /**
   * Query
   */
  queryConversations: function(spec) {
    if (spec.folderId && !spec.filter) {
      return new DirectFolderQuery({
        db: this._db,
        folderId: spec.folderId
      });
    }
  }
};

return QueryManager;
});
