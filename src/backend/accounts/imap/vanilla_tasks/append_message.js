
import { shallowClone } from 'shared/util';

import  TaskDefiner from '../../../task_infra/task_definer';

import { Composer } from '../../../drafts/composer';

/**
 * Perform an IMAP APPEND of the provided message to a folder on the server.
 * This exists to fulfill the use-case of saving a message to the sent folder.
 * We (effectively) snapshot a draft MessageInfo structure as part of our task
 * arguments.
 *
 * This is not appropriate for verbatim transfers of messages between servers.
 */
export default TaskDefiner.defineSimpleTask([
  {
    name: 'append_message',

    async plan(ctx, rawTask) {
      let plannedTask = shallowClone(rawTask);

      // TODO: account online resource
      plannedTask.resources = [];

      // We don't have any a priori name-able exclusive resources.  Our records
      // are either orthogonal or will only be dynamically discovered while
      // we're running.
      plannedTask.exclusiveResources = [
      ];

      plannedTask.priorityTags = [
      ];

      // TODO: have relPriority prioritize older messages so they more or less
      // go out in FIFO order.

      await ctx.finishTask({
        taskState: plannedTask
      });
    },

    async execute(ctx, req) {
      let account = await ctx.universe.acquireAccount(ctx, req.accountId);
      let folderInfo = account.getFolderById(req.folderId);

      // -- Create the composer.
      const composer = new Composer(req.messageInfo, account);

      await composer.buildMessage({
        includeBcc: true
      });

      // -- Generate the blob
      const composedBlob = composer.superBlob;
      // XXX and now, unfortunately, because browserbox does not support Blobs,
      // we need to have the entire message as a string.  This is a problem, of
      // course.
      const composedString =
        new FileReaderSync().readAsBinaryString(composedBlob);

      // TODO: implement heartbeat/renewWakeLock support.  Ideally this happens
      // naturally as part of the fix for the blob deficiency above, but if not,
      // we can do the same monkeypatch/hack that SMTP uses to get this.
      await account.pimap.upload(
        ctx,
        folderInfo.path,
        composedString,
        { flags: ['\\Seen'] }
      );

      await ctx.finishTask({
      });
    },
  }
]);
