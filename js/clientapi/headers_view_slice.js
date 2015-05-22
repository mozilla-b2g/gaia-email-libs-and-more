define(function(require) {
'use strict';

let WindowedListView = require('./windowed_list_view');
let MailHeader = require('./mail_header');

function HeadersViewSlice(api, handle, ns) {
  WindowedListView.call(this, api, MailHeader, handle);
  this._nextSnippetRequestValidAt = 0;
}
HeadersViewSlice.prototype = Object.create(WindowedListView.prototype);

/**
 * Ensure that we have snippets for all of the messages in this view.
 *
 * Includes some request suppression logic
 *
 * NB: Currently this assumes that we only display the contents of a single
 * conversation.
 * TODO: generalize to have message-centric sync_body-style logic
 */
HeadersViewSlice.prototype.ensureSnippets = function() {
  let snippetsNeeded = this.items.some((header) => {
    return header && header.snippet === null;
  });

  if (snippetsNeeded) {
    // Forbid us from making snippet requests more than once every 10 seconds.
    // We put this logic inside the snippetsNeeded guard so that we don't count
    // a case where no snippets are needed (because of lazy loading) and then
    // suppress the case where we would want to fire.
    if (this._nextSnippetRequestValidAt > Date.now()) {
      return;
    }
    this._nextSnippetRequestValidAt = Date.now() + 10000;

    // NB: We intentionally do not use a handle as there's no reason this needs
    // to be statefully associated with a list view.
    this._api.__bridgeSend({
      type: 'fetchSnippets',
      convIds: [this.conversationId]
    });
  }
};

return HeadersViewSlice;
});
