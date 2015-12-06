'use strict';

import { extractSimpleLogicPrefixedEvents } from './simple_logic_prefixed';

export function fetchDetectExtract(urlStr) {
  let parsedUrl = new URL(urlStr, document.location.href);
  return fetch(parsedUrl.href).then((response) => {
    let mimetype = response.headers.get('Content-Type');
    if (mimetype === 'application/json' ||
        /\.json$/.test(parsedUrl.pathname)) {
      return response.json().then((obj) => {
        if (obj.tests) {
          return {
            data: obj,
            dataType: 'gelam-test'
          };
        } else if (Array.isArray(obj)) {
          return {
            data: obj,
            dataType: 'raw-events'
          };
        }
      });
    } else if (/log$/.test(parsedUrl.pathname)) {
      // - Text log file, assume simple "logic: " prefixed JSON
      return response.text().then((str) => {
        return {
          data: extractSimpleLogicPrefixedEvents(str),
          dataType: 'raw-events'
        };
      });
    }
  });
}
