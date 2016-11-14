/**
 * Attempt to adapt the mozlog format we see with mochitest into logic-looking
 * events so we get some UI for free and can perhaps experience a degree of
 * synergy.
 */
export function coerceMozLogToLogic(objs) {
  return objs.map((obj) => {
    // Many lines are just action=log, message="..."
    let o = {
      time: obj.time,
      namespace: obj.thread,
      type: obj.action,
      details: obj.message
    };
    // But some, like mochitest's action=suite_start are actually structured, so
    // let's just treat anything that lacks a message as worth propagating the
    // rest of the non-default keys/values.
    if (!o.details) {
      let details = o.details = {};
      for (let key of Object.keys(obj)) {
        switch (key) {
          case 'source':
          case 'thread':
          case 'time':
          case 'action':
          case 'message':
          case 'level':
          case 'pid':
            break;
          default:
            details[key] = obj[key];
            break;
        }
      }
    }
    return o;
  });
}
