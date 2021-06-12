/**
 * Undoable operations describe the operation that was performed for
 * presentation to the user and hold onto a handle that can be used to undo
 * whatever it was.  While the current UI plan does not call for the ability to
 * get a list of recently performed actions, the goal is to make it feasible
 * in the future.
 */
export default function UndoableOperation({ api, id, operation, affectedCount, affectedType,
                             undoableTasksPromise }) {
  this._api = api;
  /**
   * A locally unique id to the owning API instance.  Currently it is the handle
   * of the message that was sent for the request that can be undone, but you
   * should not depend on that for anything other than simplified debugging.
   */
  this.id = id;
  /**
   * @oneof[
   *   @case['read']{
   *     Marked messages/conversations as read.
   *   }
   *   @case['unread']{
   *     Marked messages/conversations as unread.
   *   }
   *   @case['star']{
   *     Starred messages/conversations.
   *   }
   *   @case['unstar']{
   *     Unstarred messages/conversations.
   *   }
   *   @case['modifytags']{
   *     Added and/or removed tags.
   *   }
   *   @case['modifylabels']{
   *     Added and/or removed tags.
   *   }
   *   @case['move']{
   *     Moved messages/conversations.
   *   }
   *   @case['copy']{
   *     Copied messages/conversations.
   *   }
   *   @case['trash']{
   *     Deleted messages/conversations by moving to trash folder.  (Or nuking
   *     if the message already was living in the trash folder.)
   *   }
   * ]
   */
  this.operation = operation;
  /**
   * The number of things affected by this operation, `affectedType` indicates
   * whether it was 'conversation' or 'message'.
   */
  this.affectedCount = affectedCount;
  this.affectedType = affectedType;

  this._undoableTasksPromise = undoableTasksPromise;
  this._undoRequested = false;
}
UndoableOperation.prototype = {
  toString: function() {
    return '[UndoableOperation]';
  },
  toJSON: function() {
    return {
      type: 'UndoableOperation',
      affectedType: this.affectedType,
      affectedCount: this.affectedCount
    };
  },

  undo: function() {
    if (!this._undoableTasksPromise) {
      return;
    }
    this._undoableTasksPromise.then((undoTasks) => {
      this._api.__scheduleUndoTasks(this, undoTasks);
    });
    this._undoableTasksPromise = null;
    // We can't issue the undo until we've heard the longterm id, so just flag
    // it to be processed when we do.
    if (!this._longtermIds) {
      this._undoRequested = true;
      return;
    }
  },
};
