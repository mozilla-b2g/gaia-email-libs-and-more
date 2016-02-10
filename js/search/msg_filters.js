define(function(require) {
'use strict';

const { DEFAULT_SEARCH_EXCERPT_SETTINGS } = require('../syncbase');

/**
 * Filters that operate on messages directly.  These also get wrapped by the
 * MessageSpreadFilter for use by the conversation filters.
 **/

return {
  author: {
    constructor: require('./filters/message/author_filter'),
    params: null
  },
  recipients: {
    constructor: require('./filters/message/recipients_filter'),
    params: null
  },
  subject: {
    constructor: require('./filters/message/subject_filter'),
    params: {
      excerptSettings: DEFAULT_SEARCH_EXCERPT_SETTINGS
    }
  },
  body: {
    constructor: require('./filters/message/body_filter'),
    params: {
      excerptSettings: DEFAULT_SEARCH_EXCERPT_SETTINGS,
      includeQuotes: false
    }
  },
  bodyAndQuotes: {
    constructor: require('./filters/message/body_filter'),
    params: {
      excerptSettings: DEFAULT_SEARCH_EXCERPT_SETTINGS,
      includeQuotes: true
    }
  }
};
});
