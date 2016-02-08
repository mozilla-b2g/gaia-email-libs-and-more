define(function() {
'use strict';

/**
 * A filter that adapts message filters to be run against conversations by
 * requesting the messages for the conversation be loaded and then running the
 * filter on each of the returned messages.  The gather structure is likewise
 * dynamically computed.
 */
function MessageSpreadFilter({ wrappedFilterDef }, args) {
  this.wrappedFilter =
    new wrappedFilterDef.constructor(wrappedFilterDef.params, args);

  this.gather = {
    messages: this.wrappedFilter.gather
  };
  // Although this is about the filtering cost, not the gathering cost, it
  // arguably is more expensive to do something N times than 1 time.
  this.cost = this.wrappedFilter.cost * 20;

  this.alwaysRun = this.wrappedFilter.alwaysRun;
}
MessageSpreadFilter.prototype = {
  test: function(gathered) {
    let wrappedFilter = this.wrappedFilter;
    // messages will be an array whose items look like { message, bodyContents }
    // and the like.  The gatherers create siblings to the root item in each
    // context level.
    for (let messageContext of gathered.messages) {
      let matchInfo = wrappedFilter.test(messageContext);
      if (matchInfo) {
        return matchInfo;
      }
    }

    return null;
  },

};
return MessageSpreadFilter;
});
