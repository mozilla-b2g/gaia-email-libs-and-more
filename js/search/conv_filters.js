define(function(require) {
'use strict';

/**
 * This file defines the mapping between the searchFolderConversations
 * `spec.filter` and the classes that get instantiated.  (The values specified
 * for the keys are passed to the constructors verbatim.)  The `QueryManager`
 * uses us for this.  It then looks at the instantiated filters to derive the
 * gatherers required.
 **/

// The conversation specific filters.
const convFilters = {
  participants: {
    constructor: require('./filters/conversation/participants_filter'),
    params: null
  },
};

const msgFilters = require('./msg_filters');
const MessageSpreadFilter =
  require('./filters/conversation/message_spread_filter');
for (let key of Object.keys(msgFilters)) {
  let msgFilterDef = msgFilters[key];
  convFilters[key] = {
    constructor: MessageSpreadFilter,
    params: { wrappedFilterDef: msgFilterDef }
  };
}

return convFilters;
});
