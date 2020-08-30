/**
 * Helper for tasks that operate on conversations but may want to filter
 * messages by messageId or apply a selector like "last".
 *
 * Supported selectors:
 * - last: Returns only the last message in the list of messages.  Appropriate
 *   for operations like starring/flagging a message when the state of the
 *   conversation is a union over all the messages and so only one message needs
 *   to be modified and it might be a bit crazy to modify all of the messages.
 *
 * TODO: put this into a subdirectory with some commonality that results in a
 * more useful name than "utils"/etc.
 */
export function selectMessages(messages, onlyMessages, selector) {
  let filtered = messages;
  if (onlyMessages) {
    filtered = filtered.filter((message) => {
      return (onlyMessages.indexOf(message.id) !== -1);
    });
  }

  if (selector) {
    switch (selector) {
      case 'last':
        filtered = filtered.slice(-1);
        break;
      default:
        throw new Error('unsupported message selector:' + selector);
    }
  }

  return filtered;
}
