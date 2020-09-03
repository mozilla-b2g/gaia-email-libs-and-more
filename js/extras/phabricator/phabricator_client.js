/**
 * Thin API layer for talking to Phabricator.
 */
export default class PhabricatorClient {
  constructor({ serverUrl, apiToken }) {
    this.serverUrl = new URL(serverUrl);
    this.apiToken = apiToken;
  }

  async apiCall(method, params) {
    const url = `${this.serverUrl.origin}/api/${method}`;

    const body = new FormData();

    body.set('output', 'json');
    body.set('api.token', this.apiToken);
    body.set('params', JSON.stringify(params));

    const resp = await fetch(
      url,
      {
        method: 'POST',
        body
      });
    const result = await resp.json();
    return result;
  }
}