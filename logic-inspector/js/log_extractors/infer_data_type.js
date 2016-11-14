/**
 * Given an array of JSON objects, attempt to determine their flavor/dataType
 * based on known object shapes.
 */
export function inferDataType(objs) {
  // If there's nothing in there, pretend we've got logic events.
  if (!objs.length) {
    return 'raw-logic-events';
  }

  // logic events have a namespace and a type and nothing
  let first = objs[0];
  if (first.namespace && first.type) {
    return 'raw-logic-events';
  }

  // mozlog: http://mozbase.readthedocs.io/en/latest/mozlog.html
  if (first.source && first.thread && first.action) {
    return 'mozlog';
  }
}
