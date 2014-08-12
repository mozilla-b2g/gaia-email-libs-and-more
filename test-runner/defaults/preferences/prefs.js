pref("toolkit.defaultChromeURI", "chrome://test-runner/content/test-runner.xul");
pref("browser.dom.window.dump.enabled", true);

// developer preferences; get more errors:
pref("javascript.options.showInConsole", true);
pref("dom.report_all_js_exceptions", true);

pref("dom.mozApps.debug", true);

// DeviceStorage: have testing mode be disabled so the override mode does what
// we want.  See makeAndSetDeviceStorageTarget in loggest-chrome-runner.js.
pref("device.storage.testing", false);

// something wants to prompt real bad, and our fake prompts don't work.
pref("browser.prompt.allowNative", true);

// make sure we can use mozbrowser/mozapp with iframes
pref("dom.mozBrowserFramesEnabled", true);
// turn off OOP stuff
pref("dom.ipc.processCount", 0);
pref("dom.ipc.browser_frames.oop_by_default", false);
// stop random OOP subprocesses getting spun up.
pref("dom.ipc.processPrelaunch.enabled", false);

// (newly added, should help keep IPC disabled?)
pref("dom.ipc.tabs.disabled", true);


// Make apps install without prompting. (This is currently not used because
// we don't pass the initial validation stuff, so we use
// DOMApplicationRegistry.confirmInstall
pref("dom.mozApps.auto_confirm_install", true);

// make tests go faster by disabling mozStorage's fsyncs
pref("toolkit.storage.synchronous", 0); // OFF
