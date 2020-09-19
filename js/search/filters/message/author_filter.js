import searchPatternFromArgs from '../search_pattern_from_args';
import matchVerbatimHighlight from '../../match_verbatim_highlight';

/**
 * Author filter that checks the actual message (compare with the optimized
 * conversation participant filter that maybe should not exist).  Also checks
 * replyTo which the conversation participant one currently does not/cannot.
 */
export default function AuthorFilter(params, args) {
  this.searchPattern = searchPatternFromArgs(args);
}
AuthorFilter.prototype = {
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
        if (addressPair.name) {
          let matchInfo = matchVerbatimHighlight(searchPattern, addressPair.name);
          if (matchInfo) {
            return matchInfo;
          }
        }

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
