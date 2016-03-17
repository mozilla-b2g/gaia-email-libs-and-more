define(function(require) {
'use strict';

return {
  name: 'vis_facet',

  derivedViews: {
    vis_facet: function() {
      return new Promise(function(resolve) {
        require(['./vega_derived_view'], function(mod) {
          resolve(mod);
        });
      });
    }
  },

  tocs: {
    vis_facet: function() {
      return new Promise(function(resolve) {
        require(['./tocs'], function(mod) {
          resolve(mod);
        });
      });
    }
  }
};
});
