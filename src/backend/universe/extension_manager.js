import logic from 'logic';

/**
 * Tracks the set of activated extensions and registers them with the
 * appropriate subsystems.  Right now, this is done eagerly on top of
 * lazy-capable mechanisms.
 *
 * ## Lazy Capable? ##
 *
 * Each (worker) extension definition exposes some self-descriptive namespacing
 * gunk which exposes a function that when invoked returns a Promise that gets
 * resolved with the actual backing implementation.  Right now we use dynamic
 * AMD-style requires in those cases.
 *
 * The idea is that there's enough metadata about the extension point so we can
 * know when we actually need to load the modules without loading them.  For
 * example, with view TOCs (Table-of-Contents), we only need to load them when
 * a view using them is requested, and by chunking based on namespace, we can
 * do that.
 *
 * We're not doing the
 */
export default function ExtensionManager({ derivedViewManager, tocManager }) {
  logic.defineScope(this, 'ExtensionManager');
  this._extensionDefs = [];

  this._derivedViewManager = derivedViewManager;
  this._tocManager = tocManager;
}
ExtensionManager.prototype = {
  registerExtension: function(extDef, source) {
    logic(this, 'registerExtension', { name: extDef.name, source });
    this._extensionDefs.push(extDef);

    // TODO: make this stuff actually lazy when merited.
    // We would probably lazify most things by handing the the managers the
    // provider-module-providing function and give it responsibility for
    // memoizing the providers.

    if (extDef.derivedViews) {
      for (let namespace of Object.keys(extDef.derivedViews)) {
        extDef.derivedViews[namespace]().then(
          (provider) => {
            this._derivedViewManager.registerDerivedViewProvider(
              namespace, provider);
          },
          (ex) => {
            logic(
              this, 'extensionRequireError',
              {
                name: extDef.name,
                entryPoint: 'derivedView',
                ex,
                stack: ex.stack
              });
          });
      }
    }

    if (extDef.tocs) {
      for (let namespace of Object.keys(extDef.tocs)) {
        extDef.tocs[namespace]().then(
          (provider) => {
            this._tocManager.registerNamespaceProvider(namespace, provider);
          },
          (ex) => {
            logic(
              this, 'extensionRequireError',
              {
                name: extDef.name,
                entryPoint: 'tocs',
                ex,
                stack: ex.stack
              });
          });
      }
    }
  },

  registerExtensions: function(extensionDefs, source) {
    logic(this, 'registerExtensions', { source });
    for (let extDef of extensionDefs) {
      this.registerExtension(extDef, source);
    }
  },
};
