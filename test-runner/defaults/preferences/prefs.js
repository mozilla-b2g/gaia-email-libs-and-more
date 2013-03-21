pref("toolkit.defaultChromeURI", "chrome://test-runner/content/test-runner.xul");
pref("browser.dom.window.dump.enabled", true);

// developer preferences; get more errors:
pref("javascript.options.showInConsole", true);
pref("dom.report_all_js_exceptions", true);

// something wants to prompt real bad, and our fake prompts don't work.
pref("browser.prompt.allowNative", true);

// turn off OOP stuff
pref("dom.mozBrowserFramesEnabled", true);
pref("dom.ipc.processCount", 0);
pref("dom.ipc.browser_frames.oop_by_default", false);

pref("dom.ipc.processPrelaunch.enabled", false);

// make tests go faster by disabling mozStorage's fsyncs
pref("toolkit.storage.synchronous", 0); // OFF
