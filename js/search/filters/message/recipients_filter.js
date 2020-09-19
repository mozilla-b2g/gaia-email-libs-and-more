import searchPatternFromArgs from '../search_pattern_from_args';
import matchVerbatimHighlight from '../../match_verbatim_highlight';

export default function RecipientsFilter(params, args) {
  this.searchPattern = searchPatternFromArgs(args);
}
RecipientsFilter.prototype = {
  /**
   * We don't need anything beyond the message.
   */
  gather: {
    // message is implicit to the context
  },

  /**
   * Orders of magnitude: boolean (1), string (10), honking big string (100).
   */
  cost: 20,

  /**
   * Depending on incoming/outgoing folder type, the recipients list may be
   * important for UI purposes.  We perhaps could/should parameterize this.
   */
  alwaysRun: true,

  test: function(gathered) {
    let searchPattern = this.searchPattern;

    function checkList(recipients) {
      if (!recipients) {
        return null;
      }
      for (let recipient of recipients) {
        if (recipient.name) {
          let matchInfo = matchVerbatimHighlight(searchPattern, recipient.name);
          if (matchInfo) {
            return matchInfo;
          }
        }

        let matchInfo = matchVerbatimHighlight(searchPattern, recipient.address);
        if (matchInfo) {
          return matchInfo;
        }
      }
      return null;
    }

    let message = gathered.message;
    return checkList(message.to) ||
           checkList(message.cc) ||
           checkList(message.bcc);
  },
};
