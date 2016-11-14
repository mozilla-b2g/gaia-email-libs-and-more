export function extractNewlineDelimitedJsonEvents(bodyStr) {
  let events = [];
  for (let line of bodyStr.split(/\n/g)) {
    try {
      events.push(JSON.parse(line));
    } catch (ex) {
      // lines that failed to parse probably were not JSON, but if it looks like
      // it wanted to be, generate a warning.
      if (line.startsWith('{')) {
        console.warn('parse problem on', line, 'exception:', ex);
      }
    }
  }

  return events;
}
