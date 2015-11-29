export function extractSimpleLogicPrefixedEvents(bodyStr) {
  let events = [];
  for (let line of bodyStr.split(/\n/g)) {
    if (/^logic:/.test(line)) {
      try {
        events.push(JSON.parse(line.substring(7)));
      } catch (ex) {
        // lines that failed to parse probably were not JSON!
      }
    }
  }

  return events;
}
