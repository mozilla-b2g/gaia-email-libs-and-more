import logic from 'logic';


/**
 * Builds and maintains a bidirectional mapping between FolderId and Gmail label
 * for an account.
 *
 * This isn't entirely as straightforward as it seems because special-use
 * folders need to be identified by their SPECIAL-USE type rather than their
 * IMAP path.  (Or at least, that's their canonical form.)
 *
 * Examples:
 * - "INBOX" is \Inbox
 * - "[Gmail]/Sent Mail" is \Sent
 */
function GmailLabelMapper(ctx, foldersTOC) {
  logic.defineScope(this, 'GmailLabelMapper', { ctxId: ctx.id });

  this._labelToFolderId = new Map();
  this._folderIdToLabel = new Map();

  this._buildLabelMap(foldersTOC);
}
GmailLabelMapper.prototype = {
  _buildLabelMap: function(foldersTOC) {
    for (let folderInfo of foldersTOC.getAllItems()) {
      let label;
      // This is effectively an inverse of our folder inference mapping.
      // XXX let's perhaps clean up the folder list logic for gmail to only use
      // special-use and not do any inference.  And then we can save off the
      // explicit label name and just use that.
      switch (folderInfo.type) {
        // [Gmail] doesn't exist as far as we're concerned.
        case 'nomail':
          continue;
        case 'inbox':
          label = '\\Inbox';
          break;
        case 'drafts':
          label = '\\Drafts';
          break;
        case 'all':
        case 'archive':
          label = '\\All';
          break;
        case 'important':
          label = '\\Important';
          break;
        case 'sent':
          label = '\\Sent';
          break;
        case 'starred':
          label = '\\Flagged';
          break;
        case 'trash':
          label = '\\Trash';
          break;
        case 'junk':
          label = '\\Junk';
          break;
        default:
          label = folderInfo.path;
          break;
      }

      this._labelToFolderId.set(label, folderInfo.id);
      this._folderIdToLabel.set(folderInfo.id, label);
      // Useful but too chatty right now.
    }
    // Labels may be user-authored with privacy implications, so use an
    // underscore to indicate the data is private.
    logic(this, 'mapEstablished', { _labelToFolderId: this._labelToFolderId });
  },

  /**
   * Convert GMail labels as used by X-GM-LABELS into FolderId values.
   *
   * Note that this is slightly more complex than mapping through the path.
   * Special folders are identified by their SPECIAL-USE rather than their path.
   *
   * @return {FolderId[]}
   */
  labelsToFolderIds: function(gmailLabels) {
    let folderIds = new Set();
    for (let gmailLabel of gmailLabels) {
      let folderId = this._labelToFolderId.get(gmailLabel);
      if (!folderId) {
        // This is a serious invariant violation, so do report the specific
        // missing label as non-private, but keep the others private unless
        // they also fail.
        logic(this, 'missingLabelMapping',
              { label: gmailLabel, _allLabels: gmailLabels });
      } else {
        folderIds.add(folderId);
      }
    }
    return folderIds;
  },


  /**
   * Given a `FolderId`, return the "label" that X-GM-LABELS understands.  This
   * string should never be exposed to the user.
   *
   * @param {FolderId}
   * @return {String}
   */
  folderIdToLabel: function(folderId) {
    return this._folderIdToLabel.get(folderId);
  },

  /**
   * Given an array of `FolderId`s, return an array of gmail label strings that
   * X-GM-LABELS understands.  The values should never be exposed to the user.
   *
   * Note that even though we have transitioned to always storing folder id's
   * in a Set, we continue to return an array because we pass these to
   * browserbox and it still wants an Array.
   *
   * @param {Set<FolderId>} folderIds
   * @return {String[]}
   */
  folderIdsToLabels: function(folderIds) {
    return folderIds.map((folderId) => {
      return this._folderIdToLabel.get(folderId);
    });
  }
};

export default GmailLabelMapper;
