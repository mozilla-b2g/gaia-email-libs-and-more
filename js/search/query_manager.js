define(function(require) {
'use strict';

const logic = require('logic');

const DirectFolderQuery = require('./query/direct_folder_query');
const FilteringFolderQuery = require('./query/filtering_folder_query');

const DirectConversationQuery = require('./query/direct_conv_query');
const FilteringConversationQuery = require('./query/filtering_conv_query');

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
  _buildFilters: function(filterSpec, filterers) {
    let filters = [];
    if (filterSpec) {
      for (let key of Object.keys(filterSpec)) {
        let filterDef = filterers[key];
        if (filterDef) {
          let filter =
            new filterDef.constructor(filterDef.params, filterSpec[key]);
          filter.resultKey = key;
          filters.push(filter);
        }
      }
    }
    return filters;
  },

  /**
   * Build the gatherer hierarchy by walking the dependency-graph (sorta
   * GraphQL-ish) specified on the filters/summarizers/etc. passed in.
   *
   * @param {String} [arg.bootstrapKey]
   *   Explicit gather key to use to bootstrap the gather context.  This is
   *   for cases like message searching where we want "message" to always be
   *   available and the hierarchy ends up being an ugly mess if we don't.
   *   This way we can have { message, bodyContents }, versus the
   *   { messageId, message: { message, bodyContents } } we'd end up without
   *   this.  (Technically in the initial message searching case we could
   *   probably alter the data-flow so that the initial gather context is
   *   directly { message }, but this will cease to be an option if/when we
   *   are driving the filtering from an index that only has the message id's.
   *   Our bootstrap off of { messageId } and gratuitous read() of data we
   *   already have is mitigated by our caching layer.  The normalization is
   *   a nice byproduct).
   *
   *   Note that if this is used, the gatherer will throw away the initially
   *   passed-in context.  So, again, in the message case, { messageId } will
   *   be consumed but ignored and the return value will just be { message }.
   *   This is currently fine but in the future NestedGatherer may want to have
   *   a rootGather() function that understands the context difference and
   *   mixes the results when the returned value is not the passed-in value.
   */
  _buildGatherHierarchy: function({ consumers, rootGatherDefs, dbCtx,
                                    bootstrapKey }) {
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

    let bootstrapGatherer = null;
    if (bootstrapKey) {
      let bootstrapDef = rootGatherDefs[bootstrapKey];
      bootstrapGatherer =
        new bootstrapDef.constructor(dbCtx, bootstrapDef.params);
    }

    let rootGatherer = new NestedGatherer(bootstrapKey, bootstrapGatherer);
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
    let filters = this._buildFilters(spec.filter, conversationFilters);

    let dbCtx = {
      db: this._db,
      ctx
    };
    let rootGatherer = this._buildGatherHierarchy({
      consumers: filters,
      rootGatherDefs: conversationGatherers,
      dbCtx
    });
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
    // -- Direct conversation queries fast-path out
    if (spec.conversationId && !spec.filter) {
      return new DirectConversationQuery({
        db: this._db,
        conversationId: spec.conversationId
      });
    }

    // -- Build the list of filters and determine gatherer dependencies.
    let filters = this._buildFilters(spec.filter, messageFilters);

    let dbCtx = {
      db: this._db,
      ctx
    };
    // The messages case
    let rootGatherer = this._buildGatherHierarchy({
      consumers: filters,
      rootGatherDefs: messageGatherers,
      bootstrapKey: 'message',
      dbCtx
    });
    return new FilteringConversationQuery({
      ctx,
      db: this._db,
      conversationId: spec.conversationId,
      filterRunner: new FilterRunner({ filters }),
      rootGatherer
    });
  }
};

return QueryManager;
});
