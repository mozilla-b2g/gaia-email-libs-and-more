import GatherConversation from './gatherers/conv';
import GatherConversationMessages from './gatherers/conv_messages';
import MessageGatherers from './msg_gatherers';

export default {
  conversation: {
    constructor: GatherConversation,
    params: null,
    nested: null
  },
  messages: {
    constructor: GatherConversationMessages,
    params: null,
    nestedRootKey: 'message',
    nested: MessageGatherers,
  },
};
