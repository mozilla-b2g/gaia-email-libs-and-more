/**
 * Helper for the TransactionChewer to synchronously map user and group PHIDs
 * to `IdentityInfo` object dictionaries that will be filled in later in a batch
 * when the async `gatherDataFromServer` is called.
 */
export class UserChewer {
  constructor() {
    this._phidToInfo = new Map();
  }

  /**
   * Map a `USER` or `PROJ` PHID to a live-updating `IdentityInfo` object which
   * will have its state finalized when the async `gatherDataFromServer` method
   * is called and resolves.
   */
  mapPhid(phid) {
    let info = this._phidToInfo.get(phid);
    if (info) {
      return info;
    }

    info = {
      name: null,
      address: null,
      nick: null,
      phid,
    };
    this._phidToInfo.set(phid, info);
    return info;
  }

  /**
   * Asynchornously perform batched lookups of users and projects, fixing up all
   * info values handed out by prior calls to `mapPhid`.
   *
   * TODO: Handle paging/limits, although this is perhaps something that the
   * client should be helping with.  (Noting that this is a case where we
   * expect a 1:1 correspondence between the number of phids we provide and the
   * number of results we get, which is different than the sync cases, for
   * example.)
   */
  async gatherDataFromServer(client) {
    const userPhids = [];
    const userPhidMap = new Map();

    const projPhids = [];
    const projPhidMap = new Map();

    for (const [phid, info] of this._phidToInfo.values()) {
      if (phid.startsWith('PHID-USER')) {
        userPhids.push(phid);
        userPhidMap.set(phid, info);
      } else {
        projPhids.push(phid);
        projPhidMap.set(phid, info);
      }
    }

    let userSearchPromise;
    let projSearchPromise;

    if (userPhids.length > 0) {
      userSearchPromise = client.apiCall(
        'user.search',
        {
          constraints: {
            phids: userPhids,
          }
        }
      );
    } else {
      userSearchPromise = Promise.resolve({ data: [] });
    }

    if (projPhids.length > 0) {
      projSearchPromise = client.apiCall(
        'project.search',
        {
          constraints: {
            phids: projPhids,
          },
        }
      );
    } else {
      projSearchPromise = Promise.resolve({ data: [] });
    }

    const userResults = await userSearchPromise;
    for (const userInfo of userResults.data) {
      const info = userPhidMap.get(userInfo.phid);
      // Remove the users as we match them up for invariant checking.
      userPhidMap.delete(userInfo.phid);

      info.name = userInfo.fields.realName;
      info.nick = `@${userInfo.fields.username}`;
    }

    const projResults = await projSearchPromise;
    for (const projInfo of projResults.data) {
      const info = projPhidMap.get(projInfo.phid);
      projPhidMap.delete(projInfo.phid);

      info.name = projInfo.description;
      info.nick = `#${projInfo.name}`;
    }

    if (userPhidMap.size !== 0) {
      console.warn('Some user lookups did not resolve:', userPhidMap);
    }
    if (projPhidMap.size !== 0) {
      console.warn('Some project lookups did not resolve:', projPhidMap);
    }
  }
}