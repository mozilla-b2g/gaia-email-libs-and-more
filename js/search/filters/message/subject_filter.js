define(function(require) {
'use strict';

const searchPatternFromArgs = require('../search_pattern_from_args');
const matchExcerptHighlight = require('../../match_excerpt_highlight');

function SubjectFilter(params, args) {
  this.excerptSettings = params.excerptSettings;
  this.searchPattern = searchPatternFromArgs(args);
}
SubjectFilter.prototype = {
  /**
   * We don't need anything beyond what's already provided on messages.
   */
  gather: {
    // message is implicit to the context
  },

  /**
   * Orders of magnitude: boolean (1), string (10), honking big string (100).
   */
  cost: 10,

  /**
   * Everyone wants a highlighted matching subject snippet!
   */
  alwaysRun: true,

  test: function(gathered) {
    return matchExcerptHighlight(
      this.searchPattern, gathered.message.subject, null, this.excerptSettings);
  },

};
return SubjectFilter;
});
