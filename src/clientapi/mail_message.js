import evt from 'evt';

import ContactCache from './contact_cache';
import MailAttachment from './mail_attachment';

import keyedListHelper from './keyed_list_helper';

import { showBlobInImg } from './blob_helpers';

function filterOutBuiltinFlags(flags) {
  // so, we could mutate in-place if we were sure the wire rep actually came
  // over the wire.  Right now there is de facto rep sharing, so let's not
  // mutate and screw ourselves over.
  var outFlags = [];
  for (var i = flags.length - 1; i >= 0; i--) {
    if (flags[i][0] !== '\\') {
      outFlags.push(flags[i]);
    }
  }
  return outFlags;
}

/**
 * Email overview information for displaying the message in the list as planned
 * for the current UI.  Things that we don't need (ex: to/cc/bcc) for the list
 * end up on the body, currently.  They will probably migrate to the header in
 * the future.
 *
 * Events are generated if the metadata of the message changes or if the message
 * is removed.  The `BridgedViewSlice` instance is how the system keeps track
 * of what messages are being displayed/still alive to need updates.
 *
 * # Attachments and Events #
 * The `attachments` property is a list of rich `MailAttachment` instances.  The
 * instances maintain object identity throughout the life of this object,
 * although the array containing them will change (currently), so don't directly
 * retain references to the array.
 *
 * In theory, the set of attachments for a message remains constant, but the
 * following things could happen:
 * - Drafts.  Drafts have messages added and removed all the time.  For sanity,
 *   if we own a draft, we have it maintain its identity, so you will see these
 *   happen.
 * - Attachment downloading will generate changes in the MailAttachment state,
 *   including size changes (it's initially just an estimate), plus overlay
 *   metadata changes as the download in enqueued, progresses, and completes.
 * - Opaque containers like encrypted messages or MS-TNEF parts may expand into
 *   additional parts as they are downloaded.
 * - Attachments may potentially be detached from a message to conserve server
 *   space, resulting in a change of MIME type.
 * - Other horrible stuff, AKA, try and architect things so your world doesn't
 *   end if the attachments change.
 *
 * The events that can happen:
 * - on us (prior to our emitting our own 'change' event):
 *   - attachment:add
 *   - attachment:change
 *   - attachment:remove
 * - on the MailAttachment instances themselves:
 *   - change
 *   - remove
 *
 * Note that while these events are occurring, our `attachments` property
 * continues to have its original value.  If you want to consult that value with
 * its new state then you should wait for the message's `change` event to be
 * emitted.
 */
export default function MailMessage(api, wireRep, overlays, matchInfo, slice) {
  evt.Emitter.call(this);
  this._api = api;
  this._slice = slice;

  // Store the wireRep so it can be used for caching.
  // XXX we can and should probably stop doing this after minor cleanup
  this._wireRep = wireRep;

  this.id = wireRep.id;
  this.guid = wireRep.guid;

  this.author = ContactCache.resolvePeep(wireRep.author);
  this.to = ContactCache.resolvePeeps(wireRep.to);
  this.cc = ContactCache.resolvePeeps(wireRep.cc);
  this.bcc = ContactCache.resolvePeeps(wireRep.bcc);
  this.replyTo = wireRep.replyTo;

  this._relatedParts = wireRep.relatedParts;
  this.bodyReps = wireRep.bodyReps;
  // references is included for debug/unit testing purposes, hence is private
  this._references = wireRep.references;

  // actual attachments population occurs in __update
  this.attachments = [];
  this.__update(wireRep);
  this.__updateOverlays(overlays);
  this.hasAttachments = wireRep.hasAttachments;

  this.subject = wireRep.subject;
  this.snippet = wireRep.snippet;
  this.matchInfo = matchInfo;
}
MailMessage.prototype = evt.mix({
  toString: function() {
    return '[MailHeader: ' + this.id + ']';
  },
  toJSON: function() {
    return {
      type: 'MailHeader',
      id: this.id
    };
  },

  __update: function(wireRep) {
    this._wireRep = wireRep;
    if (wireRep.snippet !== null) {
      this.snippet = wireRep.snippet;
    }

    this.date = new Date(wireRep.date);

    this.isRead = wireRep.flags.indexOf('\\Seen') !== -1;
    this.isStarred = wireRep.flags.indexOf('\\Flagged') !== -1;
    this.isRepliedTo = wireRep.flags.indexOf('\\Answered') !== -1;
    this.isForwarded = wireRep.flags.indexOf('$Forwarded') !== -1;
    this.isJunk = wireRep.flags.indexOf('$Junk') !== -1;
    // NB:
    this.isDraft = wireRep.draftInfo !== null;
    this.isServerDraft = wireRep.flags.indexOf('\\Draft') !== -1;
    // TODO: this really wants a first-class mapping along the lines of how
    // labels works.
    this.tags = filterOutBuiltinFlags(wireRep.flags);
    this.labels = this._api._mapLabels(this.id, wireRep.folderIds);

    // Messages in the outbox will have `sendProblems` populated like so:
    // {
    //   error: null,
    //   badAddresses: null,
    //   sendFailures: 2
    // }
    this.sendProblems =
      (wireRep.draftInfo && wireRep.draftInfo.sendProblems) || {};

    // Related parts and bodyReps have no state we need to maintain.  Just
    // replace them with the new copies for simplicity.
    this._relatedParts = wireRep.relatedParts;
    this.bodyReps = wireRep.bodyReps;

    // Attachment instances need to be updated rather than replaced.
    this.attachments = keyedListHelper({
      wireReps: wireRep.attachments,
      existingRichReps: this.attachments,
      constructor: MailAttachment,
      owner: this,
      idKey: 'relId',
      addEvent: 'attachment:add',
      changeEvent: 'attachment:change',
      removeEvent: 'attachment:remove'
    });
  },

  __updateOverlays: function(overlays) {
    let downloadMap = overlays.download;
    // Loop over all attachments even if there isn't a download map; when the
    // map gets retracted, that's still a notable change that we need to update
    // for.
    for (let attachment of this.attachments) {
      let downloadOverlay = downloadMap && downloadMap.get(attachment.relId);
      attachment.__updateDownloadOverlay(downloadOverlay);
      attachment.emit('change');
    }

    this.isDownloadingEmbeddedImages = false;
    if (downloadMap) {
      for (let relId of downloadMap.keys()) {
        if (relId[0] === 'r') {
          this.isDownloadingEmbeddedImages = true;
          break;
        }
      }
    }
  },

  /**
   * Release subscriptions associated with the header; currently this just means
   * tell the ContactCache we no longer care about the `MailPeep` instances.
   */
  release: function() {
    ContactCache.forgetPeepInstances([this.author], this.to, this.cc, this.bcc);
  },

  /**
   * In Gmail, removes the \Inbox label from a message.  For other account
   * types, this currently does nothing.  But I guess the idea would be that
   * we'd trigger a move to an archive folder.
   *
   * @return {UndoableOperation|null}
   *   An undoable operation is returned is anything is done, null otherwise.
   */
  archiveFromInbox: function() {
    // Filter things down to only inbox folders.  (This lets us avoid an inbox
    // lookup and a potentially redundant/spurious remove in one swoop.  Not
    // that the back-end really cares.  It's SMRT.)
    let curInboxFolders = this.labels.filter(folder => folder.type === 'inbox');
    if (curInboxFolders.length) {
      return this.modifyLabels({ removeLabels: curInboxFolders });
    }
    return null;
  },

  /**
   * Delete this message by moving the messages to the trash folder if not
   * currently in the trash folder.  Permanent deletion is triggered if the
   * message is already in the trash folder.
   */
  trash: function() {
    return this._api.trash([this]);
  },

  /*
   * Copy this message to another folder.
   */
  /*
  copyMessage: function(targetFolder) {
    return this._slice._api.copyMessages([this], targetFolder);
  },
  */

  /**
   * Move this message to another folder.  This should *not* be used on gmail,
   * instead modifyLabels should be used.
   */
  move: function(targetFolder) {
    return this._api.move([this], targetFolder);
  },

  /**
   * Set or clear the read status of this message.
   */
  setRead: function(beRead) {
    return this._api.markRead([this], beRead);
  },

  toggleRead: function() {
    return this.setRead(!this.isRead);
  },

  /**
   * Set or clear the starred/flagged status of this message.
   */
  setStarred: function(beStarred) {
    return this._api.markStarred([this], beStarred);
  },

  toggleStarred: function() {
    return this.setStarred(!this.isStarred);
  },

  /**
   * Add and/or remove tags/flags from this message.
   *
   * @param {String[]} [args.addTags]
   * @param {String[]} [args.removeTags]
   */
  modifyTags: function(args) {
    return this._api.modifyTags([this], args);
  },

  /**
   * And and/or remove gmail labels from this message.  This only makes sense
   * for gmail, and we expose labels as Folders.
   *
   * @param {MailFolder[]} [args.addLabels]
   * @param {MailFolder[]} [args.removeLabels]
   */
  modifyLabels: function(args) {
    return this._api.modifyLabels([this], args);
  },

  /**
   * Returns the number of bytes needed before we can display the full
   * body. If this value is large, we should warn the user that they
   * may be downloading a large amount of data. For IMAP, this value
   * is the amount of data we need to render bodyReps and
   * relatedParts; for POP3, we need the whole message.
   */
  get bytesToDownloadForBodyDisplay() {
    // If this is unset (old message), default to zero so that we just
    // won't show any warnings (rather than prompting incorrectly).
    return this._wireRep.bytesToDownloadForBodyDisplay || 0;
  },

  /**
   * Assume this is a draft message and return a Promise that will be resolved
   * with a populated `MessageComposition` instance.
   */
  editAsDraft: function() {
    if (!this.isDraft) {
      throw new Error('Nice try, but I am not a magical localdraft.');
    }
    return this._api.resumeMessageComposition(this);
  },

  /**
   * Start composing a reply to this message.
   *
   * @param {'sender'|'all'}
   *   - sender: Reply to just the sender/author of the message.
   *   - all: Reply to all; everyone on the to/cc and the author will end up
   *     either on the "to" or "cc" lines.
   * @param {Boolean} [options.noComposer=false]
   *   Pass true if you don't want us to instantiate a MessageComposition
   *   for you automatically.  In this case the Promise contains a MessageNamer
   *   object.
   * @return {Promise<MessageComposition>}
   */
  replyToMessage: function(replyMode, options) {
    return this._slice._api.beginMessageComposition(
      this, null,
      {
        command: 'reply',
        mode: replyMode,
        noComposer: options && options.noComposer
      });
  },

  /**
   * Start composing a forward of this message.
   *
   * @param {'inline'} forwardMode
   *   We only support inline right now, so this pretty much doesn't matter, but
   *   you want to pass 'inline' for now.
   * @param {Object} [options]
   * @param {Boolean} [options.noComposer=false]
   *   Pass true if you don't want us to instantiate a MessageComposition
   *   for you automatically.  In this case the Promise contains a MessageNamer
   *   object.
   * @return {Promise<MessageComposition>}
   */
  forwardMessage: function(forwardMode, options) {
    return this._slice._api.beginMessageComposition(
      this, null,
      {
        command: 'forward',
        mode: forwardMode,
        noComposer: options && options.noComposer
      });
  },

  /**
   * true if this is an HTML document with inline images sent as part of the
   * messages.
   */
  get embeddedImageCount() {
    if (!this._relatedParts) {
      return 0;
    }
    return this._relatedParts.length;
  },

  /**
   * Trigger download of the body parts for this message if they're not already
   * downloaded.  This method does not currently return any value.  The idea is
   * that you wait for events on the message to know when things happen.  We'll
   * probably add something like `bodyDownloadPending` to help you convey that
   * something's happening.
   */
  downloadBodyReps: function() {
    this._api._downloadBodyReps(this.id, this.date.valueOf());
  },

  /**
   * true if all the bodyReps are downloaded.
   */
  get bodyRepsDownloaded() {
    var i = 0;
    var len = this.bodyReps.length;

    for (; i < len; i++) {
      if (!this.bodyReps[i].isDownloaded) {
        return false;
      }
    }
    return true;
  },

  /**
   * true if all of the images are already downloaded.
   */
  get embeddedImagesDownloaded() {
    for (var i = 0; i < this._relatedParts.length; i++) {
      var relatedPart = this._relatedParts[i];
      if (!relatedPart.file) {
        return false;
      }
    }
    return true;
  },

  /**
   * Trigger the download of any inline images sent as part of the message.
   * Returns a promise that is resolved when the parts have been downloaded and
   * are available to showEmbeddedImages().
   */
  downloadEmbeddedImages: function() {
    var relatedPartRelIds = [];
    for (var i = 0; i < this._relatedParts.length; i++) {
      var relatedPart = this._relatedParts[i];
      if (relatedPart.file) {
        continue;
      }
      relatedPartRelIds.push(relatedPart.relId);
    }
    if (!relatedPartRelIds.length) {
      return Promise.resolve();
    }
    return this._api._downloadAttachments({
      messageId: this.id,
      messageDate: this.date.valueOf(),
      relatedPartRelIds,
      attachmentRelIds: null
    });
  },

  /**
   * Synchronously trigger the display of embedded images.
   *
   * The loadCallback allows iframe resizing logic to fire once the size of the
   * image is known since Gecko still doesn't have seamless iframes.
   */
  showEmbeddedImages: function(htmlNode, loadCallback) {
    var i, cidToBlob = {};
    // - Generate object URLs for the attachments
    for (i = 0; i < this._relatedParts.length; i++) {
      var relPart = this._relatedParts[i];
      // Related parts should all be stored as Blobs-in-IndexedDB
      if (relPart.file && !Array.isArray(relPart.file)) {
        cidToBlob[relPart.contentId] = relPart.file;
      }
    }

    // - Transform the links
    var nodes = htmlNode.querySelectorAll('.moz-embedded-image');
    for (i = 0; i < nodes.length; i++) {
      var node = nodes[i],
          cid = node.getAttribute('cid-src');

      // eslint-disable-next-line no-prototype-builtins
      if (!cidToBlob.hasOwnProperty(cid)) {
        continue;
      }
      showBlobInImg(node, cidToBlob[cid]);
      if (loadCallback) {
        node.addEventListener('load', loadCallback, false);
      }

      node.removeAttribute('cid-src');
      node.classList.remove('moz-embedded-image');
    }
  },

  /**
   * @return[Boolean]{
   *   True if the given HTML node sub-tree contains references to externally
   *   hosted images.  These are detected by looking for markup left in the
   *   image by the sanitization process.  The markup is not guaranteed to be
   *   stable, so don't do this yourself.
   * }
   */
  checkForExternalImages: function(htmlNode) {
    var someNode = htmlNode.querySelector('.moz-external-image');
    return someNode !== null;
  },

  /**
   * Transform previously sanitized references to external images into live
   * references to images.  This un-does the operations of the sanitization step
   * using implementation-specific details subject to change, so don't do this
   * yourself.
   */
  showExternalImages: function(htmlNode, loadCallback) {
    // querySelectorAll is not live, whereas getElementsByClassName is; we
    // don't need/want live, especially with our manipulations.
    var nodes = htmlNode.querySelectorAll('.moz-external-image');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (loadCallback) {
        node.addEventListener('load', loadCallback, false);
      }
      node.setAttribute('src', node.getAttribute('ext-src'));
      node.removeAttribute('ext-src');
      node.classList.remove('moz-external-image');
    }
  },
});
