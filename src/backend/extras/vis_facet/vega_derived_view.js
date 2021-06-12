import DynamicFullTOC from 'gelam/db/dynamic_full_toc';
import FieldExtractor from 'gelam/search/field_extractor';

import makeHackyVegaDataflow from './make_hacky_vega_dataflow';

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

function makeView(viewDef) {
  const vegaHack = makeHackyVegaDataflow({
    backendDef: viewDef.backend,
    // XXX this is part of the convId/plurality hardcoding dumbness.
    idKey: 'convId'
  });
  const orderingKey = (viewDef.type === 'facet') ? viewDef.backend.orderingKey
    : 'id';

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

  const extractor = new FieldExtractor({
    extract: viewDef.backend.extract,
    aggregate: viewDef.backend.aggregate
  });

  // vegaHack.flush
  const toc = new DynamicFullTOC({
    comparator,
    idKey: '_id',
    topOrderingKey: null,
    onFlush: () => {
      vegaHack.flush();
      let values = vegaHack.getValues();
      // The difference between facet and overview *for now* is how we map the
      // results into the TOC.  In a facet, we expect each value to be a faceted
      // item that should be its own item in the TOC.  For an overview, we
      // just tunnel all of the resulting items across the wire inside a single
      // item.  This overview approach is probably excessively limiting and
      // is horrible in terms of minimizing deltas on the front-end.
      if (viewDef.type === 'facet') {
        // TODO: be able to better determine when facets have changed.
        // Hacky debug investigation reveals that the _id is stable
        // for the facets across multiple calls, so we can't rely on them changing
        // to let us know when data has been dirtied.  We might be able to hook
        // directly into the data graph or use object identity.  For the time
        // being, full rebuilds with persistence of id's is probably fine.
        toc.setItems(values);
      } else {
        // TODO: similar issues to the above, although in this case we're not
        // benefitting from the consistent use of the TOC/view abstraction as
        // much since there's logically only one item.  This might be a good
        // simpler driving case for buffering accumulated changesets and
        // sending them over the wire.  This would entail a new streamlike
        // object that uses the batch manager and __update() call idiom
        // transparently but otherwise is not a normal view.  The streamlike
        // object could then also be used for the actual items used by the
        // windowed list view/proxy.  The proxy might need a minor enhancement
        // so that it understands the idea of accumulating delta data for an
        // object that's already fully known to the front-end, but that it has
        // to ask for and provide the full data when requested.  Although this
        // would probably be needless complexity/overkill in most cases, there
        // is an argument for making it the normal case that most logic simply
        // does not use/trigger.
        toc.setItems([{ id: 'single', values }]);
      }
      toc.applyTOCMetaChanges(extractor.aggregated);
    }
  });


  const derivedView = new VegaDerivedView({
    gather: viewDef.backend.gather,
    extractor,
    toc,
    vegaHack
  });

  return { toc, derivedView };
}

export default function makeVisFacetDerivedView(viewDef) {
  if (viewDef.type === 'facet' ||
      viewDef.type === 'overview') {
    return makeView(viewDef);
  }
  throw new Error('NoneSuch');
}
