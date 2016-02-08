define(function(require) {
'use strict';

const logic = require('logic');

const DirectFolderQuery = require('./query/direct_folder_query');
const FilteringFolderQuery = require('./query/filtering_folder_query');

const DirectConversationQuery = require('./query/direct_conv_query');

const FilterRunner = require('./filter_runner');
const NestedGatherer = require('./nested_gatherer');

const conversationFilters = require('./conv_filters');
const conversationGatherers = require('./conv_gatherers');
const messageFilters = require('./msg_filters');
const messageGatherers = require('./msg_gatherers');

/**
 * Abstraction for all persistent database queries.  Read "search.md" for the
 * deets.
 */
function QueryManager({ db }) {
  logic.defineScope(this, 'QueryManager');
  this._db = db;
}
QueryManager.prototype = {
  /**
   * Build the gatherer hierarchy by walking the dependency-graph (sorta
   * GraphQL-ish) specified on the filters/summarizers/etc. passed in.
   */
  _buildGatherHierarchy: function(consumers, rootGatherDefs, dbCtx) {
    let traverse = (curGatherer, reqObj, gatherDefs) => {
      for (let key of Object.keys(reqObj)) {
        let gatherDef = gatherDefs[key];

        if (!gatherDef.nested) {
          if (!curGatherer.hasGatherer(key)) {
            curGatherer.addGatherer(
              key,
              new gatherDef.constructor(dbCtx, gatherDef.params));
          }
        } else {
          let childGatherer;
          if (!curGatherer.hasGatherer(key)) {
            childGatherer = curGatherer.makeNestedGatherer(
              key,
              gatherDef.nestedRootKey,
              new gatherDef.constructor(dbCtx, gatherDef.params));
          } else {
            childGatherer = curGatherer.getGatherer(key);
          }
          traverse(childGatherer, reqObj[key], gatherDef.nested);
        }
      }
    };

    let rootGatherer = new NestedGatherer();
    for (let consumer of consumers) {
      traverse(rootGatherer, consumer.gather, rootGatherDefs);
    }

    return rootGatherer;
  },

  /**
   * Find conversations that match a filter spec.
   */
  queryConversations: function(ctx, spec) {
    // -- Direct folder queries fast-path out.
    if (spec.folderId && !spec.filter) {
      return new DirectFolderQuery({
        db: this._db,
        folderId: spec.folderId
      });
    }

    // -- Build the list of filters and determine gatherer dependencies.
    let filters = [];
    if (spec.filter) {
      for (let key of Object.keys(spec.filter)) {
        let filterDef = conversationFilters[key];
        if (filterDef) {
          let filter =
            new filterDef.constructor(filterDef.params, spec.filter[key]);
          filter.resultKey = key;
          filters.push(filter);
        }
      }
    }

    let dbCtx = {
      db: this._db,
      ctx
    };
    let rootGatherer =
      this._buildGatherHierarchy(filters, conversationGatherers, dbCtx);
    return new FilteringFolderQuery({
      ctx,
      db: this._db,
      folderId: spec.folderId,
      filterRunner: new FilterRunner({ filters }),
      rootGatherer
    });
  },

  /**
   * Find messages in a specific conversation that match a filter spec.
   */
  queryConversationMessages: function(ctx, spec) {
    return new DirectConversationQuery({
      db: this._db,
      conversationId: spec.conversationId
    });
  }
};

return QueryManager;
});
