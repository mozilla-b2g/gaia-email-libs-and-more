import { DEFAULT_SEARCH_EXCERPT_SETTINGS } from '../syncbase';

import AuthorFilter from './filters/message/author_filter';
import AuthorAddressFilter from './filters/message/author_address_filter';
import RecipientsFilter from './filters/message/recipients_filter';
import SubjectFilter from './filters/message/subject_filter';
import BodyFilter from './filters/message/body_filter';

/**
 * Filters that operate on messages directly.  These also get wrapped by the
 * MessageSpreadFilter for use by the conversation filters.
 **/

export default {
  author: {
    constructor: AuthorFilter,
    params: null
  },
  authorAddress: {
    constructor: AuthorAddressFilter,
    params: null
  },
  recipients: {
    constructor: RecipientsFilter,
    params: null
  },
  subject: {
    constructor: SubjectFilter,
    params: {
      excerptSettings: DEFAULT_SEARCH_EXCERPT_SETTINGS
    }
  },
  body: {
    constructor: BodyFilter,
    params: {
      excerptSettings: DEFAULT_SEARCH_EXCERPT_SETTINGS,
      includeQuotes: false
    }
  },
  bodyAndQuotes: {
    constructor: BodyFilter,
    params: {
      excerptSettings: DEFAULT_SEARCH_EXCERPT_SETTINGS,
      includeQuotes: true
    }
  }
};
