/**
 * Helper for the BugChewer to map login names to fully looked up user infos.
 */
export class UserChewer {
  constructor() {
    this._loginToInfo = new Map();
  }

  /**
   * Map a bugzilla login name to a live-updating `IdentityInfo`
   * object which will have its state finalized when the async
   * `gatherDataFromServer` method is called and resolves.
   */
  mapLogin(login) {
    let info = this._loginToInfo.get(login);
    if (info) {
      return info;
    }

    info = {
      name: null,
      address: login,
      nick: null,
    };
    this._loginToInfo.set(login, info);
    return info;
  }

  /**
   * Asynchronously perform batched lookups of users and projects, fixing up all
   * info values handed out by prior calls to `mapPhid`.
   *
   * TODO: Handle paging/limits, although this is perhaps something that the
   * client should be helping with.  (Noting that this is a case where we
   * expect a 1:1 correspondence between the number of phids we provide and the
   * number of results we get, which is different than the sync cases, for
   * example.)
   */
  async gatherDataFromServer(client) {
    const loginToInfo = this._loginToInfo;
    const params = new URLSearchParams();
    for (const login of loginToInfo.keys()) {
      params.append('names', login);
    }

    const results = await client.restCall('user', params);
    for (const user of results.users) {
      const info = loginToInfo.get(user.name);
      info.name = user.real_name;
      info.nick = user.nick;
    }

    if (results.users.length !== loginToInfo.size) {
      console.warn(`${ loginToInfo.size - results.users.length} ser lookups did not resolve.`);
    }
  }
}