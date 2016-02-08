define(function(require) {
'use strict';

return {
  conversation: {
    constructor: require('./gatherers/conv'),
    params: null,
    nested: null
  },
  messages: {
    constructor: require('./gatherers/conv_messages'),
    params: null,
    nestedRootKey: 'message',
    nested: require('./msg_gatherers')
  }
};
});
