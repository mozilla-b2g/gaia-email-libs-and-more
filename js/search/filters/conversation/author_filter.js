define(function(require) {
'use strict';

const searchPatternFromArgs = require('../search_pattern_from_args');
const matchVerbatimHighlight = require('../../match_verbatim_highlight');

function AuthorFilter(params, args) {
  this.searchPattern = searchPatternFromArgs(args);
}
AuthorFilter.prototype = {
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
return AuthorFilter;
});
