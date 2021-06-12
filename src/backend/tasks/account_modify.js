import logic from 'logic';
import TaskDefiner from '../task_infra/task_definer';

import { NOW } from 'shared/date';

/**
 * Manipulate account settings.  This mainly entails mapping the request fields
 * onto the actual storage fields.
 */
export default TaskDefiner.defineSimpleTask([
  {
    name: 'account_modify',

    async plan(ctx, rawTask) {
      // Access the account for read-only consultation.  Because we don't need
      // to wait on any network access and because of how things actually work,
      // we could absolutely acquire this for write mutation and do an explicit
      // write.  However, by using the clobber mechanism we are able to have
      // prettier/more explicit logging and also have unit tests that more
      // directly ensure what we're doing in here is correct as it relates to
      // to our conditionalized username/password logic.
      const accountDef = ctx.readSingle('accounts', rawTask.accountId);
      const accountClobbers = new Map();
      for (let key in rawTask.mods) {
        const val = rawTask.mods[key];

        switch (key) {
          case 'name':
            accountClobbers.set(['map'], val);
            break;

          case 'username':
            // See the 'password' section below and/or
            // MailAPI.modifyAccount docs for the rationale for this
            // username equality check:
            if (accountDef.credentials.outgoingUsername ===
                accountDef.credentials.username) {
              accountClobbers.set(['credentials', 'outgoingUsername'], val);
            }
            accountClobbers.set(['credentials', 'username'], val);
            break;
          case 'incomingUsername':
            accountClobbers.set(['credentials', 'username'], val);
            break;
          case 'outgoingUsername':
            accountClobbers.set(['credentials', 'outgoingUsername'], val);
            break;
          case 'password':
            // 'password' is for changing both passwords, if they
            // currently match. If this account contains an SMTP
            // password (only composite ones will) and the passwords
            // were previously the same, assume that they both need to
            // remain the same. NOTE: By doing this, we save the user
            // from typing their password twice in the extremely common
            // case that both passwords are actually the same. If the
            // SMTP password is actually different, we'll just prompt
            // them for that independently if we discover it's still not
            // correct.
            if (accountDef.credentials.outgoingPassword ===
                accountDef.credentials.password) {
              accountClobbers.set(['credentials', 'outgoingPassword'], val);
            }
            accountClobbers.set(['credentials', 'password'], val);
            break;
          case 'incomingPassword':
            accountClobbers.set(['credentials', 'password'], val);
            break;
          case 'outgoingPassword':
            accountClobbers.set(['credentials', 'outgoingPassword'], val);
            break;
          case 'oauthTokens':
            accountClobbers.set(
              ['credentials', 'oauth2', 'accessToken'],
              val.accessToken);
            accountClobbers.set(
              ['credentials', 'oauth2', 'refreshToken'],
              val.refreshToken);
            accountClobbers.set(
              ['credentials', 'oauth2', 'expireTimeMS'],
              val.expireTimeMS);
            break;

          case 'identities':
            // TODO: support identity mutation
            // we expect a list of identity mutation objects, namely an id and the
            // rest are attributes to change
            break;

          case 'servers':
            // TODO: support server mutation
            // we expect a list of server mutation objects; namely, the type names
            // the server and the rest are attributes to change
            break;

          case 'syncRange':
            accountClobbers.set(['syncRange'], val);
            break;

          case 'syncInterval':
            accountClobbers.set(['syncInterval'], val);
            break;

          case 'notifyOnNew':
            accountClobbers.set(['notifyOnNew'], val);
            break;

          case 'playSoundOnSend':
            accountClobbers.set(['playSoundOnSend'], val);
            break;

          case 'setAsDefault':
            // Weird things can happen if the device's clock goes back in time,
            // but this way, at least the user can change their default if they
            // cycle through their accounts.
            if (val) {
              accountClobbers.set(['defaultPriority'], NOW());
            }
            break;

          default:
            logic(ctx, 'badModifyAccountKey', { key });
            break;
        }
      }

      await ctx.finishTask({
        atomicClobbers: {
          accounts: new Map([
            [
              rawTask.accountId,
              accountClobbers
            ]
          ])
        }
      });
    }
  }
]);
