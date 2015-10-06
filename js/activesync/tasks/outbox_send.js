define(function(require) {
'use strict';

const co = require('co');

const TaskDefiner = require('../../task_infra/task_definer');

const sendMail = require('../smotocol/send_mail');
const sendMail12x = require('../smotocol/send_mail_12x');

/**
 * ActiveSync outbox sending:
 * - The server puts the message in the sent folder automatically, so that's
 *   easy/free and we use the default saveSentMessage implementation.
 */
return TaskDefiner.defineComplexTask([
  require('../../task_mixins/mix_outbox_send'),
  {
    shouldIncludeBcc: function(/* account */) {
      // ActiveSync auto-appends.
      return true;
    },

    sendMessage: co.wrap(function*(ctx, account, composer) {
      let conn;
      // Unlike other tasks, we handle errors explicitly in-band, so convert
      // connection establishing errors to a formal return value.
      try {
        conn = yield account.ensureConnection();
      } catch (ex) {
        return { error: ex.message };
      }

      let mimeBlob = composer.superBlob;
      let progress = (/*loaded, total*/) => {
        composer.heartbeat('ActiveSync sendMessage');
      };

      try {
        if (conn.currentVersion.gte('14.0')) {
          yield* sendMail(conn, { mimeBlob, progress });
        } else {
          yield* sendMail12x(conn, { mimeBlob, progress });
        }
      } catch (ex) {
        return { error: ex.message };
      }

      return { error: null };
    }),
  }
]);
});
