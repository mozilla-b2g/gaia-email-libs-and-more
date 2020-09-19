import matchExcerptHighlight from '../../match_excerpt_highlight';
import searchPatternFromArgs from '../search_pattern_from_args';

const CT_AUTHORED_CONTENT = 0x1;

export default function BodyFilter(params, args) {
  this.includeQuotes = params.includeQuotes;
  this.excerptSettings = params.excerptSettings;
  this.searchPattern = searchPatternFromArgs(args);
  this.gather = {
    // message is implicit
    bodyContents: { includeQuotes: this.includeQuotes }
  };
}
BodyFilter.prototype = {
  /**
   * Orders of magnitude: boolean (1), string (10), honking big string (100).
   */
  cost: 100,

  /**
   * If the filter is used, we currently assume that the UI will want a snippet
   * to display when a match occurs.  If this fails to always be true, we'll
   * want this configured by a parameter.  (Maybe introduce an additional
   * filter key?)
   */
  alwaysRun: true,

  /*
   * Gathered will have the form { message, bodyContents, ... }
   */
  test: function(gathered) {
    let { searchPattern, excerptSettings, includeQuotes } = this;
    for (let bodyContent of gathered.bodyContents) {
      if (bodyContent.type === 'html') {
        let match = matchExcerptHighlight(
          searchPattern, bodyContent.textBody, null, excerptSettings);
        if (match) {
          return match;
        }
      } else if (bodyContent.type === 'plain') {
        let bodyRep = bodyContent.rep;
        for (var iRep = 0; iRep < bodyRep.length; iRep += 2) {
          var etype = bodyRep[iRep]&0xf, block = bodyRep[iRep + 1];

          // Ignore blocks that are not message-author authored unless we are
          // told to match quotes.
          if (!includeQuotes && etype !== CT_AUTHORED_CONTENT) {
            continue;
          }

          let match = matchExcerptHighlight(
            searchPattern, block, null, excerptSettings);
          if (match) {
            return match;
          }
        }
      }
    }

    return null;
  },

};
