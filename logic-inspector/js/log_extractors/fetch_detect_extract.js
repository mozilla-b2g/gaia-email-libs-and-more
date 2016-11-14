import { extractSimpleLogicPrefixedEvents } from './simple_logic_prefixed';
import { extractNewlineDelimitedJsonEvents } from './extract_ndjson';

import { coerceMozLogToLogic } from './coerce_mozlog';

import { inferDataType } from './infer_data_type';

export function fetchDetectExtract(urlStr) {
  let parsedUrl = new URL(urlStr, document.location.href);
  return fetch(parsedUrl.href).then((response) => {
    if (!response.ok) {
      console.error('fetch failed with response:', response);
      return Promise.reject('failed fetch');
    }
    let mimetype = response.headers.get('Content-Type');
    if (mimetype === 'application/json' ||
        /\.json$/.test(parsedUrl.pathname)) {
      console.debug('consuming as single JSON blob...');
      return response.json().then((obj) => {
        if (obj.tests) {
          console.debug('...inferring GELAM representation');
          return {
            data: obj,
            dataType: 'gelam-test'
          };
        } else if (Array.isArray(obj)) {
          console.debug('...inferring raw representation (array)');
          return {
            data: obj,
            dataType: 'raw-logic-events'
          };
        } else {
          console.warn('...unknown JSON shape.');
        }
      });
    } else if (/\.(?:ndjson|jsonl)$/.test(parsedUrl.pathname)) {
      // - Newline-delimited JSON
      console.debug('consuming as Newline-Delimited JSON');
      return response.text().then((str) => {
        // Extract and attempt to infer the underlying schema
        let data = extractNewlineDelimitedJsonEvents(str);
        let dataType = inferDataType(data);
        // Attempt to coerce things to logic events
        switch (dataType) {
          case 'mozlog':
            data = coerceMozLogToLogic(data);
            dataType = 'raw-logic-events';
            break;
          default:
            // the UI knows how to surface an unsupported type already.
            break;
        }
        return { data, dataType };
      });
    } else if (/log$/.test(parsedUrl.pathname)) {
      // - Text log file, assume simple "logic: " prefixed JSON
      console.debug('consuming as interleaved "logic: " prefixed JSON');
      return response.text().then((str) => {
        return {
          data: extractSimpleLogicPrefixedEvents(str),
          dataType: 'raw-logic-events'
        };
      });
    }
  });
}
