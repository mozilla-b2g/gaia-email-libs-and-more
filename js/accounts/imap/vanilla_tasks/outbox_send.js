import TaskDefiner from '../../../task_infra/task_definer';

import MixinOutboxSend from '../../../task_mixins/mix_outbox_send';

/**
 * Vanilla IMAP conditionally generates an "append_message" job to save the
 * message to the sent folder.  Some servers automatically save a copy there
 * as a side-effect of the SMTP send, and in those cases we know to do nothing.
 *
 * The ImapAccount instance knows whether or not a server saves to the sent
 * folder.  Currently this is based on looking at the CAPABILITY.  Since we know
 * we are not gmail, that just leaves coremail right now.  However, we do know
 * that Fastmail can optionally automatically save to the sent folder, so
 * someday we could make understand that.  Or not, since we expect fastmail to
 * move to JMAP soon.
 */
export default TaskDefiner.defineComplexTask([
  MixinOutboxSend,
  {
    shouldIncludeBcc(account) {
      // If the SMTP send automatically saves the message in the sent folder,
      // we need to put the BCC's in there while sending.
      return account.sentMessagesAutomaticallyAppearInSentFolder;
    },

    saveSentMessage({ ctx, account, newTasks, messages, messageInfo }) {
      // - Locally forget about the message
      messages.splice(messages.indexOf(messageInfo), 1);

      // - Issue an append if the server won't have done it for us.

      if (!account.sentMessagesAutomaticallyAppearInSentFolder) {
        newTasks.push({
          type: 'append_message',
          accountId: ctx.accountId,
          folderId: account.getFirstFolderWithType('sent').id,
          messageInfo
        });
      }
    }
  }
]);
