import logic from 'logic';

import DirectFolderConversationsQuery from './query/direct_folder_conv_query';
import FilteringFolderQuery from './query/filtering_folder_query';

import DirectFolderMessagesQuery from './query/direct_folder_messages_query';

import DirectConversationMessagesQuery from './query/direct_conv_messages_query';
import FilteringConversationMessagesQuery from './query/filtering_conv_query';

import FilterRunner from './filter_runner';
import NestedGatherer from './nested_gatherer';

import conversationFilters from './conv_filters';
import conversationGatherers from './conv_gatherers';
import messageFilters from './msg_filters';
import messageGatherers from './msg_gatherers';

/**
 * Abstraction for all persistent database queries.  Read "search.md" for the
 * deets.
 */
export default function QueryManager({ db, derivedViewManager }) {
  logic.defineScope(this, 'QueryManager');
  this._db = db;
  this._derivedViewManager = derivedViewManager;
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
   * @param [arg.consumers]
   *   The list of filters/whatever that expose a `gather` object that expresses
   *   what data they need gathered.
   * @param [arg.rootGatherDefs]
   *   The gatherer definition dictionary to start all gather traversals from.
   *   This is different for when filtering messages versus conversations, etc.
   * @param [arg.dbCtx]
   *   Context dictionary of the form { db, ctx } where db is the `MailDB`
   *   instance for database read needs and ctx is a `NamedContext` for logging
   *   needs.  The intent is that this is where pass-through data for the
   *   gatherers is provided.
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

  _buildDerivedViews: function(viewDefsWithContexts) {
    if (!viewDefsWithContexts) {
      return [];
    }
    const derivedViews = viewDefsWithContexts.map((viewDefWithContext) => {
      return this._derivedViewManager.createDerivedView(viewDefWithContext);
    });

    return derivedViews;
  },

  /**
   * Find conversations that match a filter spec.
   */
  queryConversations: function(ctx, spec) {
    // -- Direct folder queries fast-path out.
    if (spec.folderId && !spec.filter) {
      return new DirectFolderConversationsQuery({
        db: this._db,
        folderId: spec.folderId
      });
    }

    // -- Build the list of filters and determine gatherer dependencies.
    const filters = this._buildFilters(spec.filter, conversationFilters);

    const dbCtx = {
      db: this._db,
      ctx
    };

    const preDerivers = this._buildDerivedViews(spec.viewDefsWithContexts);
    const postDerivers = [];

    const rootGatherer = this._buildGatherHierarchy({
      consumers: [].concat(filters, preDerivers, postDerivers),
      rootGatherDefs: conversationGatherers,
      dbCtx
    });
    return new FilteringFolderQuery({
      ctx,
      db: this._db,
      folderId: spec.folderId,
      filterRunner: new FilterRunner({ filters }),
      rootGatherer,
      preDerivers,
      postDerivers
    });
  },

  /**
   * Find messages independent of conversations.
   */
  queryMessages: function(ctx, spec) {
    // -- Direct folder queries fast-path out.
    if (spec.folderId && !spec.filter) {
      return new DirectFolderMessagesQuery({
        db: this._db,
        folderId: spec.folderId
      });
    }

    // TODO: Starting with just the direct load for now to make sure that works
    // sufficiently/at all.
    throw new Error('No messages filtering yet!');
  },

  /**
   * Find messages in a specific conversation that match a filter spec.
   */
  queryConversationMessages: function(ctx, spec) {
    // -- Direct conversation queries fast-path out
    if (spec.conversationId && !spec.filter) {
      return new DirectConversationMessagesQuery({
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
    return new FilteringConversationMessagesQuery({
      ctx,
      db: this._db,
      conversationId: spec.conversationId,
      filterRunner: new FilterRunner({ filters }),
      rootGatherer
    });
  }
};
