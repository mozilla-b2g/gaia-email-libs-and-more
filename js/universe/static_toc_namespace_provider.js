define(function(require) {
'use strict';

const StaticTOC = require('../db/static_toc');

return function makeStaticTOCNamespaceProvider(staticMap) {
  const tocCache = new Map();
  return function(args) {
    const { name } = args;
    const entry = staticMap[name];
    if (!entry) {
      throw new Error('bad namespace key name: ' + name);
    }
    if (typeof(entry) === 'function') {
      return entry(args);
    }
    if (!Array.isArray(entry)) {
      throw new Error('namespace entry data not an array');
    }

    let toc = tocCache.get(name);
    if (!toc) {
      toc = new StaticTOC({
        items: entry,
        onForgotten: () => {
          tocCache.delete(name);
        }
      });
      tocCache.set(name, toc);
    }
    return args.ctx.acquire(toc);
  };
};
});
