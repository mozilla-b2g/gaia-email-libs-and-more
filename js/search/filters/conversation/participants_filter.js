define(function(require) {
'use strict';

const searchPatternFromArgs = require('../search_pattern_from_args');
const matchVerbatimHighlight = require('../../match_verbatim_highlight');

/**
 * Like the per-message Author filter but we check the ConversationInfo authors
 * aggregate list instead of the messages.  This inherently involves less data
 * but also fails to check replyTo.  Also, if we're already gathering the
 * messages for any of the other filters, this is potentially less efficient.
 * If we address the replyTo implications, it could make sense to rename this
 * back to author filter and have it hide the per-message one in the
 * conversation case.
 */
function ParticipantsFilter(params, args) {
  this.searchPattern = searchPatternFromArgs(args);
}
ParticipantsFilter.prototype = {
  /**
   * We check authors directly on the conversation since an aggregate is
   * explicitly maintained.  The conversation is implicit, so we don't request
   * anything additional.
   */
  gather: {
    conversation: true
  },

  /**
   * Orders of magnitude: boolean (1), string (10), honking big string (100).
   */
  cost: 10,

  /**
   * Everyone always wants to see highlights in matching authors!
   */
  alwaysRun: true,

  test: function(gathered) {
    let searchPattern = this.searchPattern;

    for (let author of gathered.conversation.authors) {
      if (author.name) {
        let matchInfo = matchVerbatimHighlight(searchPattern, author.name);
        if (matchInfo) {
          return matchInfo;
        }
      }

      let matchInfo = matchVerbatimHighlight(searchPattern, author.address);
      if (matchInfo) {
        return matchInfo;
      }
    }

    return null;
  },

};
return ParticipantsFilter;
});
