define(function(require) {
'use strict';

var evt = require('evt');

function RawItem(api, wireRep, overlays, matchInfo) {
  evt.Emitter.call(this);

  this.__update(wireRep);
  this.__updateOverlays(overlays);
  this.matchInfo = matchInfo;
}
RawItem.prototype = evt.mix({
  toString: function() {
    return '[RawItem]';
  },
  toJSON: function() {
    return {
      data: this.data
    };
  },

  /**
   * Loads the current unread message count as reported by the FolderStorage
   * backend. this.unread is the current number of unread messages that are
   * stored within the FolderStorage object for this folder. Thus, it only
   * accounts for messages which the user has loaded from the server.
   */
  __update: function(wireRep) {
    this.data = wireRep;
  },

  __updateOverlays: function(/*overlays*/) {
  },

  release: function() {
    // currently nothing to clean up
  }
});

return RawItem;
});
