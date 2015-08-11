define(function(require) {
'use strict';

/**
 * Asynchronously fetch the contents of a Blob, returning a Uint8Array.
 * Exists because there is no FileReader in Gecko workers and this totally
 * works.  In discussion, it sounds like :sicking wants to deprecate the
 * FileReader API anyways.
 *
 * Our consumer in this case is our specialized base64 encode that wants a
 * Uint8Array since that is more compactly represented than a binary string
 * would be.
 *
 * @param {Blob} blob
 * @param {'text'|'arraybuffer'|'json'|'document'} responseType
 *   You could pick "blob" too, but that would be pointless since you're already
 *   giving us a blob.
 * @return {Promise}
 */
return function asyncFetchBlob(blob, responseType) {
  return new Promise((resolve, reject) => {
    var blobUrl = URL.createObjectURL(blob);
    var xhr = new XMLHttpRequest();
    xhr.open('GET', blobUrl, true);
    xhr.responseType = responseType;
    xhr.onload = function() {
      // blobs currently result in a status of 0 since there is no server.
      if (xhr.status !== 0 && (xhr.status < 200 || xhr.status >= 300)) {
        reject(xhr.status);
        return;
      }
      resolve(xhr.response);
    };
    xhr.onerror = function() {
      reject('error');
    };
    try {
      xhr.send();
    }
    catch(ex) {
      console.error('XHR send() failure on blob');
      reject('exception');
    }
    URL.revokeObjectURL(blobUrl);
  });
};

}); // end define
