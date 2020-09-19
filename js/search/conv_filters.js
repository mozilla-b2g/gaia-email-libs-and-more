/**
 * This file defines the mapping between the searchFolderConversations
 * `spec.filter` and the classes that get instantiated.  (The values specified
 * for the keys are passed to the constructors verbatim.)  The `QueryManager`
 * uses us for this.  It then looks at the instantiated filters to derive the
 * gatherers required.
 **/
import msgFilters from './msg_filters';

import ParticipantsFilter from './filters/conversation/participants_filter';
import MessageSpreadFilter from './filters/conversation/message_spread_filter';

// The conversation specific filters.
const convFilters = {
  participants: {
    constructor: ParticipantsFilter,
    params: null
  },
};

for (let key of Object.keys(msgFilters)) {
  let msgFilterDef = msgFilters[key];
  convFilters[key] = {
    constructor: MessageSpreadFilter,
    params: { wrappedFilterDef: msgFilterDef }
  };
}

export default convFilters;
