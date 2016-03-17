define(function(require) {
'use strict';

// We do more targeted requires in order to avoid pulling in more than we need.
const Model = require('vega/src/core/Model');
const parse = require('vega/src/parse/');

/**
 * Create a vega model that exists only for our backend dataflow needs and hook
 * it up to our custom API for putting changes in and getting changes out.
 *
 * This exists because:
 * - I don't believe there's existing API support for this.  Although
 *   vega-dataflow is its own repo, we need the transforms that only live in
 *   vega.  Ideally there will be an API for this or a blessed idiom, and at
 *   that point, we can hopefully keep the changes within this file.
 * - vega.parse.spec() ends up building and requiring too much visualization
 *   infrastructure.  We do not need/want headless rendering to happen or be
 *   part of our JS bundles for the worker, especially since there's a chance
 *   for things to freak out about globals, etc.
 * - We need to mess with the dataflow graph at a somewhat low level since we
 *   are interested in getting hooked up to the output pipeline.
 *
 * @param {Object} arg.backendDef
 *   The backend definition, of which we care about { inputDataSource,
 *   outputDataSource, and vegaData }.
 * @param {String} arg.backendDef.inputDataSource
 *   The data source that we should stream data into.  For simplicity this is
 *   assumed to be an explicitly declared source with no transforms.
 * @param {String} arg.backendDef.outputDataSource
 *   The data source that we expect results data to show up in.
 * @param {Object} arg.backendDef.vegaData
 *   Stuff that would go in a vega "data" definition in a full visualization.
 * @param {Function(id, obj, isNew)} arg.onOutputChange
 *   NOT YET IMPLEMENTED AND MAYBE NOT NEEDED.
 *   A function to invoke when an output result changes.  All calls will contain
 *   an id.  Deletions will have a null `obj`.  Additions and changes will
 *   have an `obj` object, with only additions having `isNew` be true.
 */
return function makeHackyVegaDataflow({ backendDef, idKey }) {
  // - Create the model and define the core data-sources.
  const model = new Model();
  model.defs({
    // No useful callbakc is required because our data is all empty and
    // therefore synchronously available.
    data: parse.data(model, backendDef.vegaData, () => {})
  });

  const inputSource = model.data(backendDef.inputDataSource);
  const outputSource = model.data(backendDef.outputDataSource);

  // - Create the API we expose to our owner to add/remove items.
  // Currently we don't expose a modification API because we don't need
  // modifications yet and the predicate-based filtering APIs are disconcerting
  // enough in big-O that I don't want to naively wrap them quite yet.
  const exposeApi = {
    /**
     *
     */
    addItem: function(item) {
      console.log('inserting', item);
      inputSource.insert([item]);
    },

    removeItem: function(id) {
      // TODO: more an upstream issue, but O(n) removal is arguably silly.
      inputSource.remove((existing) => {
        return existing[idKey] === id;
      });
    },

    flush: function() {
      inputSource.fire();
    },

    getValues: function() {
      return outputSource.values();
    }
  };

  return exposeApi;
};
});
