import TaskDefiner from '../../../task_infra/task_definer';

import sendMail from '../smotocol/send_mail';
import sendMail12x from '../smotocol/send_mail_12x';

import MixOutboxSend from '../../../task_mixins/mix_outbox_send';

/**
 * ActiveSync outbox sending:
 * - The server puts the message in the sent folder automatically, so that's
 *   easy/free and we use the default saveSentMessage implementation.
 */
export default TaskDefiner.defineComplexTask([
  MixOutboxSend,
  {
    shouldIncludeBcc: function(/* account */) {
      // ActiveSync auto-appends.
      return true;
    },

    async sendMessage(ctx, account, composer) {
      let conn;
      // Unlike other tasks, we handle errors explicitly in-band, so convert
      // connection establishing errors to a formal return value.
      try {
        conn = await account.ensureConnection();
      } catch (ex) {
        return { error: ex.message };
      }

      let mimeBlob = composer.superBlob;
      let progress = (/*loaded, total*/) => {
        composer.heartbeat('ActiveSync sendMessage');
      };

      try {
        if (conn.currentVersion.gte('14.0')) {
          await sendMail(conn, { mimeBlob, progress });
        } else {
          await sendMail12x(conn, { mimeBlob, progress });
        }
      } catch (ex) {
        return { error: ex.message };
      }

      return { error: null };
    },
  }
]);
