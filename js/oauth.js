define(function(require, exports) {

  var errorutils = require('./errorutils');
  var syncbase = require('./syncbase');
  var slog = require('./slog');

  // We only support Gmail's OAUTH mechanism right now.
  var OAUTH_URL = 'https://accounts.google.com/o/oauth2/token';
  var OAUTH_CLIENT_ID = ('673813704507-educiq1od0atkerkb73qjlnphr5cg61h' +
                         '.apps.googleusercontent.com');
  var OAUTH_CLIENT_SECRET = '0A4iZ7SjLYCbm4JvmKm6D5xz';

  /**
   * Ensure that the credentials given are still valid, and refresh
   * them if not. For an OAUTH account, this may entail obtaining a
   * new access token from the server; for non-OAUTH accounts, this
   * function always succeeds.
   *
   * @param {object} credentials
   *   An object with (at a minimum) 'refreshToken' (and 'accessToken',
   *   if one had already been obtained).
   * @return {Promise}
   *   success: {boolean} True if the credentials were modified.
   *   failure: {String} A normalized error string.
   */
  exports.ensureUpdatedCredentials = function(credentials) {
    var isOauth = !!credentials.refreshToken;
    // If this is an OAUTH account, see if we need to refresh the
    // accessToken. If not, just continue on our way.
    if (isOauth &&
        (!credentials.accessToken ||
         credentials.expireTimeMS < Date.now())) {
      return renewAccessToken(credentials.refreshToken)
        .then(function(newTokenData) {
          credentials.accessToken = newTokenData.accessToken;
          credentials.expireTimeMS = newTokenData.expireTimeMS;

          slog.log('oauth:credentials-changed', {
            _accessToken: credentials.accessToken,
            expireTimeMS: credentials.expireTimeMS
          });

          return true;
        });
    } else {
      slog.log('oauth:credentials-ok');
      // Not OAUTH; everything is fine.
      return Promise.resolve(false);
    }
  };

  /**
   * Given an OAUTH refreshToken, ask the server for a new
   * accessToken. If this request fails with the 'needs-oauth-reauth'
   * error, you should invalidate the refreshToken and have the user
   * go through the OAUTH flow again.
   *
   * @param {String} refreshToken
   *   The long-lived refresh token we've stored in long-term storage.
   * @return {Promise}
   *   success: {String} { accessToken, expireTimeMS }
   *   failure: {String} normalized errorString
   */
  function renewAccessToken(refreshToken) {
    slog.log('oauth:renewing-access-token');
    return new Promise(function(resolve, reject) {
      var xhr = slog.interceptable('oauth:renew-xhr', function() {
        return new XMLHttpRequest({ mozSystem: true });
      });
      xhr.open('POST', OAUTH_URL, true);
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      xhr.timeout = syncbase.CONNECT_TIMEOUT_MS;
      xhr.send([
        'client_id=', encodeURIComponent(OAUTH_CLIENT_ID),
        '&client_secret=', encodeURIComponent(OAUTH_CLIENT_SECRET),
        '&refresh_token=', encodeURIComponent(refreshToken),
        '&grant_type=refresh_token'
      ].join(''));
      xhr.onload = function() {
        // If we couldn't retrieve the access token, either the user
        // revoked the access we granted (per Google's OAUTH docs) or
        // something has gone horribly wrong. The best we can assume
        // is that the problem will be resolved, or clarified by
        // instructing the user to reauthenticate.
        if (xhr.status < 200 || xhr.status >= 300) {
          reject('needs-oauth-reauth');
        } else {
          try {
            var data = JSON.parse(xhr.responseText);
            if (data && data.access_token) {
              slog.log('oauth:got-access-token', {
                _accessToken: data.access_token
              });
              // OAUTH returns an expire time as "seconds from now";
              // convert that to an absolute DateMS.
              resolve({
                accessToken: data.access_token,
                expireTimeMS: Date.now() + (data.expires_in * 1000)
              });
            } else {
              slog.error('oauth:no-access-token', {
                data: xhr.responseText
              });
              reject('needs-oauth-reauth');
            }
          } catch(e) {
            slog.error('oauth:bad-json', {
              error: e,
              data: xhr.responseText
            });
            reject('needs-oauth-reauth');
          }
        }
      }

      xhr.onerror = function(err) {
        reject(errorutils.analyzeException(err));
      };
    });
  }

});
