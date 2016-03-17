define(function(require) {
'use strict';

const DynamicFullTOC = require('gelam/db/dynamic_full_toc');
const FieldExtractor = require('gelam/search/field_extractor');

const makeHackyVegaDataflow = require('./make_hacky_vega_dataflow');

/**
 * Our derived view is the connective tissue between calls to `deriveStuff` from
 * the `FilteringStream` and the TOC and proxy that
 */
function VegaDerivedView({ gather, extractor, toc, vegaHack }) {
  this.gather = gather;
  this._extractor = extractor;
  this._toc = toc;
  this._vegaHack = vegaHack;
}
VegaDerivedView.prototype = {
  itemAdded: function(gathered) {
    // XXX: currently we assume extractFrom === messages.
    for (let message of gathered.messages) {
      // XXX and accordingly hardcode the convId bits.
      const item = this._extractor.extract(message, 'convId', gathered.convId);
      // lazy manipulation, will not propagate until we flush...
      this._vegaHack.addItem(item);
      // ...which we ensure happens by having the TOC announce it's dirty.
      this._toc.reportDirty();
    }
  },

  // XXX this being explicitly understood as a convId is wrong/bad.
  itemRemoved: function(convId) {
    // lazy manipulation, will not propagate until we flush...
    this._vegaHack.removeItem(convId);
    // ...which we ensure happens by having the TOC announce it's dirty.
    this._toc.reportDirty();
  }
};

function makeFacetingView(viewDef) {
  const vegaHack = makeHackyVegaDataflow({
    backendDef: viewDef.backend,
    // XXX this is part of the convId/plurality hardcoding dumbness.
    idKey: 'convId'
  });
  const orderingKey = viewDef.backend.orderingKey;

  /**
   *
   */
  const comparator = (a, b) => {
    // let null be a sentinel minimal key for top ordering key purposes.
    if (!a) {
      return -1;
    } else if (!b) {
      return 1;
    }
    return a[orderingKey].localeCompare(b[orderingKey]);
  };


  // vegaHack.flush
  const toc = new DynamicFullTOC({
    comparator,
    topOrderingKey: null,
    onFlush: () => {
      vegaHack.flush();
      let values = vegaHack.getValues();
      console.log('VALUES', values);
      // TODO: be able to better determine when facets have changed.
      // Hacky debug investigation reveals that the _id is stable
      // for the facets across multiple calls, so we can't rely on them changing
      // to let us know when data has been dirtied.  We might be able to hook
      // directly into the data graph or use object identity.  For the time
      // being, full rebuilds with persistence of id's is probably fine.
      toc.setItems(values);
    }
  });


  const derivedView = new VegaDerivedView({
    gather: viewDef.backend.gather,
    extractor: new FieldExtractor(viewDef.backend.extract),
    toc,
    vegaHack
  });

  return { toc, derivedView };
}

function makeVisFacetDerivedView(viewDef) {
  if (viewDef.type === 'facet') {
    return makeFacetingView(viewDef);
  }
  throw new Error('NoneSuch');
}

return makeVisFacetDerivedView;
});
