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
    body.set('__conduit__', '1');
    const augmentedParams = Object.assign(
      {
        __conduit__: {
          token: this.apiToken
        },
      },
      params);
    body.set('params', JSON.stringify(augmentedParams));

    // Although this fetch would normally be cross-origin and therefore require
    // CORS, we have explicitly listed the Mozilla Phabricator instance in our
    // permissions list and so BasePrincipal::IsThirdPartyURI will return false
    // because BasePrincipal::AddonAllowsLoad will return true.
    const resp = await fetch(
      url,
      {
        credentials: 'omit',
        method: 'POST',
        body
      });
    const result = await resp.json();
    // We expect this result to have a dictionary with keys/values:
    // - error_code
    // - error_info
    // - result
    if (result.error_code) {
      console.error('Got error code', result.error_code, 'with info:', result.error_info);
      throw new Error('API Call Error, see console.log output');
    }
    return result.result;
  }
}