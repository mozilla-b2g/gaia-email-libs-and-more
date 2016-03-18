define(function(require) {
'use strict';

const searchPatternFromArgs = require('../search_pattern_from_args');
const matchVerbatimHighlight = require('../../match_verbatim_highlight');

/**
 * Checks the author's email address, both from and reply-to, for a
 * case-insensitive full match.  No substring matches, no case-sensitivity.
 */
function AuthorAddressFilter(params, args) {
  this.searchPattern = searchPatternFromArgs(args, { exact: true });
}
AuthorAddressFilter.prototype = {
  /**
   * We don't need anything beyond the message.
   */
  gather: {
    // message is implicit to the context
  },

  /**
   * Orders of magnitude: boolean (1), string (10), honking big string (100).
   */
  cost: 10,

  /**
   * Depending on incoming/outgoing folder type, the author may be important for
   * UI purposes.  We perhaps could/should parameterize this.
   */
  alwaysRun: true,

  test: function(gathered) {
    let searchPattern = this.searchPattern;

    function checkList(addressPairs) {
      if (!addressPairs) {
        return null;
      }
      
      for (let addressPair of addressPairs) {
        let matchInfo = matchVerbatimHighlight(searchPattern, addressPair.address);
        if (matchInfo) {
          return matchInfo;
        }
      }

      return null;
    }

    let message = gathered.message;
    return checkList([message.author]) ||
           checkList(message.replyTo);
  },
};
return AuthorAddressFilter;
});
