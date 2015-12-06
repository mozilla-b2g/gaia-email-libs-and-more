define(function(require) {
'use strict';

const co = require('co');
const TaskDefiner = require('../task_infra/task_definer');

const { encodeInt } = require('../a64');
const { makeAccountDef, makeIdentity } = require('../db/account_def_rep');

const { configuratorModules, validatorModules } = require('../engine_glue');

const defaultPrefs = require('../default_prefs');

/**
 * Create an account using previously retrieved autoconfig data or using
 * explicit (user-provided manual-style creation) account settings.
 *
 * During account creation, we do the following online things:
 * - Validating the account parameters
 * - Discovering the specific engine type after talking to the server to
 *   identify it.
 *
 * Then it's a simple matter of persisting that state to disk.
 *
 * # Account Id's #
 *
 * The most complex issue here is the allocation of the account id.  For
 * sanity we want strictly increasing id's and we want them allocated at the
 * time of successful account creation so that mistyped passwords don't
 * result in gaps.  This necessitates storage of a counter rather than doing
 * max(existing id's)+1.
 *
 * So we continue our v1.x strategy of tracking nextAccountNum on the config
 * object.  This config object is always in-memory allowing us to use
 * atomicClobber safely as long as we are the only account_create task in flight
 * or we ensure that we do not yield control flow between our read and when
 * we finish the task, issuing the write.
 *
 * Args:
 * - userDetails
 * - domainInfo
 */
return TaskDefiner.defineSimpleTask([
  {
    name: 'account_create',

    exclusiveResources: function() {
      return [
      ];
    },

    priorityTags: function() {
      return [
      ];
    },

    execute: co.wrap(function*(ctx, planned) {
      let { userDetails, domainInfo } = planned;
      let accountType = domainInfo.type;

      // - Dynamically require the configurator and validator modules.
      let configuratorId = configuratorModules.get(accountType);
      let validatorId = validatorModules.get(accountType);

      let [configurator, validator] = yield new Promise((resolve) => {
        require(
          [configuratorId, validatorId],
          (configuratorMod, validatorMod) => {
            resolve([configuratorMod, validatorMod]);
          });
      });

      let fragments = configurator(userDetails, domainInfo);

      let validationResult = yield validator(fragments);
      // If it's an error, just return the error.
      if (validationResult.error) {
        return validationResult;
      }

      // Allocate an id for the account now that it's a sure thing.
      let accountNum = ctx.universe.config.nextAccountNum;
      let accountId = encodeInt(accountNum);

      // Hand-off the connection if one was returned.
      if (validationResult.receiveProtoConn) {
        ctx.universe.accountManager.stashAccountConnection(
          accountId, validationResult.receiveProtoConn);
      }

      let identity = makeIdentity({
        id: accountId + '.' + encodeInt(0),
        name: userDetails.displayName,
        address: userDetails.emailAddress,
        replyTo: null,
        signature: null,
        signatureEnabled: false
      });

      let accountDef = makeAccountDef({
        infra: {
          id: accountId,
          name: userDetails.emailAddress,
          type: accountType,
        },
        credentials: fragments.credentials,
        prefFields: defaultPrefs,
        typeFields: fragments.typeFields,
        engineFields: validationResult.engineFields,
        connInfoFields: fragments.connInfoFields,
        identities: [
          identity
        ]
      });

      yield ctx.finishTask({
        newData: {
          accounts: [accountDef]
        },
        atomicClobbers: {
          config: {
            nextAccountNum: accountNum + 1
          }
        }
      });

      return ctx.returnValue({
        accountId,
        error: null,
        errorDetails: null
      });
    })
  }
]);
});
