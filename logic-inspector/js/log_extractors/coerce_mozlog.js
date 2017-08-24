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
      // * mochitest just has everything in "message"
      // * web-platform-tests does source="web-platform-tests",
      //   action="process_output", with the message in "data".
      details: obj.message || obj.data
    };

    // - try helpful parsers...
    if (o.details && typeof(o.details) === 'string') {
      const extracted = maybeParseUnstructuredMessage(o.details);
      if (extracted) {
        o.namespace = extracted.namespace;
        o.type = extracted.type;
        o.details = extracted.details;
      }
    }

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

// Capture groups:
// - 1: Timestamp
// - 2: TID of the reporting thread
// - 3: "->" if sending, "<-" if receiving, redundantly encoded in group 6
// - 4: TID of the thread the reporting thread is talking to
// - 5: Protocol
// - 6: "Sending" if sending, "Recived" if receiving
// - 7: " reply" if this is a sync reply.
// - 8: The specific message being sent/received.
const RE_IPC = /^\[time: (\d+)\]\[(\d+)([<]?-[>]?)(\d+)\] \[([^\]]+)\] (Received|Sending)( reply)? {2}(.+)$/;
export function maybeParseUnstructuredMessage(msg) {
  const match = RE_IPC.exec(msg);

  if (!match) {
    return null;
  }

  const time = parseInt(match[1].slice(0, -3), 10) / 1000;

  const selfTid = parseInt(match[2], 10);
  const otherTid = parseInt(match[4], 10);

  const messageType = match[8];

  if (match[6] === 'Sending') {
    return {
      type: 'IPC:Send',
      namespace: selfTid + '',
      details: {
        sender: selfTid,
        receiver: otherTid,
        msg: messageType
      },
      time
    };
  } else {
    return {
      type: 'IPC:Recv',
      namespace: selfTid + '',
      details: {
        sender: otherTid,
        receiver: selfTid,
        msg: messageType
      },
      time
    };
  }
}
