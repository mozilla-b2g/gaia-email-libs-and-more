# Logic Inspector

## How GELAM Test Logging Works

In complex software like GELAM, console logs aren't enough to understand what's going on in tests. Instead, we view logs in the browser, allowing us to pull apart details and better understand code flow.

This file documents how the web viewer is hooked up to tests. If you're just writing tests, you don't need to read this; just run `make results` to open the viewer in your browser.

Our logs come out as JSON. But because JSON data is complex, we don't expect you to view the raw, opaque JSON output. In fact, you'll probably never want to view the data raw. You want to view it as it was intended -- in a browser, with the assistance of our log viewer. That's what `logic-inspector` is. But it's also unwieldy to have to run a local web server just to view test results. Good news! You don't have to.

During test runs, we collect logs as JSON and save them into an HTML file like `test-logs/TESTFILE-TIMESTAMP.html`:

```html
  <script>
    window.results = [/* YOUR JSON RESULTS HERE */];
  </script>
  <script src="logic-inspector/loader.js"></script>
```

Just double-click that file to view the log in your browser. No server needed.

## Automatic Reloading

Both the index at `test-logs/index.html` and individual test logs automatically reload when new results arrive. How?

1. All test run logs are stored with unique filenames, like `test-logs/$FILE-$TIMESTAMP.html`.
2. When you open any log file, your browser XHR-polls a file named `test-logs/.latest-$TESTNAME` (no timestamp), which contains a plaintext string: a link to the latest file available. 
3. Our test runner updates `.latest-$TESTNAME` to always point to the latest test run.
4. Tada! Reloading. The test run index is also updated similarly.

All of this happens in [test-chrome-runner.js](../test-runner/chrome/content/loggest-chrome-runner.js).
