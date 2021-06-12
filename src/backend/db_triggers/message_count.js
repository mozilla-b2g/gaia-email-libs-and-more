/**
 * We maintain a tally of known messages (locally) in each folder.  See the
 * `FolderMeta` defition in folder_info_rep.js for more information.
 */
export default {
  name: 'message_count',

  'msg!*!add': function(triggerCtx, message) {
    // Every folderId it belongs to gets an atomicDelta of 1.
    let folderDeltas = new Map();
    for (let folderId of message.folderIds) {
      folderDeltas.set(
        folderId,
        {
          localMessageCount: 1
        });
    }
    triggerCtx.modify({
      atomicDeltas: {
        folders: folderDeltas
      }
    });
  },

  'msg!*!change': function(triggerCtx, messageId, preInfo, message, added,
                            kept, removed) {
    if (!added.size && !removed.size) {
      return;
    }

    let folderDeltas = new Map();
    for (let folderId of added) {
      folderDeltas.set(
        folderId,
        {
          localMessageCount: 1
        });
    }
    for (let folderId of removed) {
      folderDeltas.set(
        folderId,
        {
          localMessageCount: -1
        });
    }

    triggerCtx.modify({
      atomicDeltas: {
        folders: folderDeltas
      }
    });
  }
};
