/**
 *
 **/

define(
  [
    'exports'
  ],
  function(

    exports
  ) {

function MailFolder() {
  this.name = null;
  this.path = null;
  this.onchange = null;
  this.onremove = null;
}
MailFolder.prototype = {
};

function MailHeader(slice, id) {
  this._slice = slice;
  this.id = id;

  this.author = null;

  this.date = null;
  this.isRead = null;
  this.isStarred = null;
  this.isRepliedTo = null;
  this.tags = null;
  this.hasAttachments = null;

  this.subject = null;
  this.snippet = null;

  this.onchange = null;
  this.onremove = null;
}
MailHeader.prototype = {
  toString: function() {
    return '[MailHeader: ' + this.id + ']';
  },

  /**
   * Delete this message
   */
  deleteMessage: function() {
  },

  /**
   * Move this message to another folder.
   */
  moveMessage: function(targetFolder) {
  },

  /**
   * Copy this message to another folder.
   */
  copyMessage: function(targetFolder) {
  },

  setRead: function(beRead) {
  },

  setStarred: function(beStarred) {
  },

  setRepliedTo: function(beRepliedTo) {
  },

  modifyTags: function(addTags, removeTags) {
  },

  /**
   * Request the `MailBody` instance for this message, passing it to the
   * provided callback function once retrieved.
   */
  getBody: function(callback) {
  },
};

/**
 * Lists the attachments in a message as well as providing a way to display the
 * body while (eventually) also accounting for message quoting.
 */
function MailBody(api, id) {
  this._api = api;
  this.id = id;

  this.to = null;
  this.cc = null;
  this.bcc = null;
  this.attachments = null;
  // for the time being, we only provide text/plain contents, and we provide
  // those flattened.
  this.bodyText = null;
}
MailBody.prototype = {
};

/**
 * Provides the file name, mime-type, and estimated file size of an attachment.
 * In the future this will also be the means for requesting the download of
 * an attachment or for attachment-forwarding semantics.
 */
function MailAttachment() {
  this.filename = null;
  this.mimetype = null;
}
MailAttachment.prototype = {
};

/**
 * Undoable operations describe the operation that was performed for
 * presentation to the user and hold onto a handle that can be used to undo
 * whatever it was.  While the current UI plan does not call for the ability to
 * get a list of recently performed actions, the goal is to make it feasible
 * in the future.
 */
function UndoableOperation() {
}
UndoableOperation.prototype = {
};

/**
 *
 */
function BridgedViewSlice(api, ns) {
  this._api = api;
  this._ns = ns;

  this.items = [];

  this.atTop = null;
  this.atBottom = false;

  this.onadd = null;
  this.onsplice = null;
  this.onremove = null;
}
BridgedViewSlice.prototype = {
  requestGrowth: function() {
  },
};

/**
 *
 */
function MailAPI() {
  this._nextHandle = 1;
  this.onstatuschange = null;
}
MailAPI.prototype = {
  /**
   * Send a message over/to the bridge.  The idea is that we (can) communicate
   * with the backend using only a postMessage-style JSON channel.
   */
  _bridgeSend: function(msg) {
  },

  /**
   * Process a message received from the bridge.
   */
  _bridgeReceive: function(msg) {
  },


  createAccount: function(details) {
  },

  viewAccounts: function() {
  },

  /**
   *
   */
  viewFolders: function() {
  },

  /**
   * Retrieve a slice of the contents of a folder, starting from the most recent
   * messages.
   */
  viewFolderMessages: function(folder) {
    var handle = this._nextHandle++,
        viewslice = new BridgedViewSlice(this, 'headers', handle);

    this._bridgeSend({
      type: 'viewFolderMessages',
      folderId: folder.id,
      handle: handle,
    });

    return viewslice;
  },

  /**
   * Search a folder for messages containing the given text in the sender,
   * recipients, or subject fields, as well as (optionally), the body with a
   * default time constraint so we don't entirely kill the server or us.
   *
   * Expected UX: run the search once without body, then the user can ask for
   * the body search too if the first match doesn't meet their expectations.
   */
  quicksearchFolderMessages: function(folder, text, searchBodyToo) {
  },

  //////////////////////////////////////////////////////////////////////////////
  // Batch Message Mutation
  //
  // If you want to modify a single message, you can use the methods on it
  // directly.
  //
  // All actions are undoable and return an `UndoOperation`.

  deleteMessages: function(messages) {
  },

  copyMessages: function(messages, targetFolder) {
  },

  moveMessages: function(messages, targetFolder) {
  },

  markMessagesRead: function(messages, beRead) {
  },

  markMessagesStarred: function(messages, beStarred) {
  },

  modifyMessagesTags: function(messages, addTags, removeTags) {
  },


  //////////////////////////////////////////////////////////////////////////////
};


}); // end define
