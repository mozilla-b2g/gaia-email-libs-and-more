import WindowedListView from './windowed_list_view';
import MailMessage from './mail_message';

export default function MessagesListView(api, handle) {
  WindowedListView.call(this, api, MailMessage, handle);
  this._nextSnippetRequestValidAt = 0;
}
MessagesListView.prototype = Object.create(WindowedListView.prototype);

/**
 * Ensure that we have snippets for all of the messages in this view.
 *
 * Includes some request suppression logic
 *
 * NB: Currently this assumes that we only display the contents of a single
 * conversation.
 * TODO: generalize to have message-centric sync_body-style logic
 */
MessagesListView.prototype.ensureSnippets = function() {
  let snippetsNeeded = this.items.some((message) => {
    return message && message.snippet === null;
  });

  if (snippetsNeeded) {
    // Forbid us from making snippet requests more than once every 5 seconds.
    // We put this logic inside the snippetsNeeded guard so that we don't count
    // a case where no snippets are needed (because of lazy loading) and then
    // suppress the case where we would want to fire.
    if (this._nextSnippetRequestValidAt > Date.now()) {
      return;
    }
    this._nextSnippetRequestValidAt = Date.now() + 5000;

    // NB: We intentionally do not use a handle as there's no reason this needs
    // to be statefully associated with a list view.
    this._api.__bridgeSend({
      type: 'fetchSnippets',
      convIds: [this.conversationId]
    });
  }
};
