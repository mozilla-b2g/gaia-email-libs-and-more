import logic from 'logic';
import WindowedListProxy from '../bridge/windowed_list_proxy';

export default function DerivedViewManager() {
  logic.defineScope(this, 'DerivedViewManager');
  this._providersByName = new Map();
}
DerivedViewManager.prototype = {
  /**
   * Register a derived view provider.
   *
   * The derived view provider is a function that takes a dictionary of the
   * form { viewDef } and returns a dictionary of the form { toc, derivedView }.
   * The TOC instance should be suitable for being acquire()d by a
   * WindowedListProxy and the derivedView just needs to be an object with a
   * `deriveStuff` method.  The TOC and derivedView can be the same object if
   * you really want, but it's probably not the best idea.  Time will tell.
   *
   * Currently there's no explicit life-cycle stuff going on with the derived
   * view, but we can add it.  Alternately, it can be the TOC's problem to
   * clean things up.
   */
  registerDerivedViewProvider: function(name, provider) {
    logic(this, 'registerDerivedViewProvider', { name });
    this._providersByName.set(name, provider);
  },

  /**
   * Given a view definition paired with a bridge named context, farm out the
   * provision of a TOC and derived view, then hook up the TOC to a proxy we
   * associate with the context and return the derived view to the caller to
   * poke stuff into via its `deriveStuff` method.
   *
   * Returns a Promise that will be resolved with the derivedView when things
   * are all hooked up.
   */
  createDerivedView: function({ viewDef, ctx }) {
    const viewMaker = this._providersByName.get(viewDef.provider);
    if (!viewMaker) {
      // XXX this should really be using `logic`
      console.warn('ViewMaker requested for', viewDef.provider, 'but not found');
      return null;
    }

    const { toc, derivedView } = viewMaker(viewDef);

    ctx.proxy = new WindowedListProxy(toc, ctx);

    // NB: This process is defined to be async, but no one actually needs to
    // wait around for it to happen, although we do need to shunt any errors to
    // logging.
    ctx.acquire(ctx.proxy).catch((err) => {
      logic(this, 'derivedViewAcquireError', { name: viewDef.provider, err });
    });
    return derivedView;
  }
};
