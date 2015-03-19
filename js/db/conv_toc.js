define(function(require) {

let a64 = require('../a64');
let RefedResource = require('../refed_resource');
let compareMsgIds = a64.cmpUI64;

/**
 * The Conversation Table-of-Contents is in charge of backing view slices
 * listing the messages in a specific conversation.
 *
 * This primarily entails tracking how many messages there are in the
 * conversation and maintaining an ordering of all those messages so that if
 * a request comes in for messages by position that we can issue the database
 * requests for them.
 *
 * This is a reference-counted object that is created on-demand as soon as a
 * view slice is requested for a given conversation and destroyed once no more
 * view slices care about.
 */
function ConversationTOC() {
  RefedResource.call(this);

  this.__deactivate();
}
ConversationTOC.prototype = RefedResource.mix({
  __activate: function() {

  },

  __deactivate: function() {
    this.ids = [];
  },

  getPayloadForId: function() {

  }
});

return ConversationTOC;
});
