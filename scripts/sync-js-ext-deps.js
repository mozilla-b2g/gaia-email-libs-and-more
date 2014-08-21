'use strict';
// (This file is executed from Node in the Makefile.)

/**
 * Keep a list of files from js/ext in sync with js/worker-config.js.
 *
 * Presently, we configure RequireJS to allow us to specify modules
 * from _both_ of the following directories using absolute paths:
 *
 *   js/
 *   js/ext/
 *
 * This allows us to not worry too much about where we should put
 * different files, and avoids some confusion about relative and
 * absolute paths; for instance, I know that I can plop a dependency
 * in 'js/ext' and I won't have to edit any RequireJS configs to make
 * it work. However, based on :mcav's understanding of the docs, it
 * isn't as simple as it would seem to implement this scheme using
 * Require's configuration; but since we have :jrburke around, maybe
 * he can take a better stab a this or suggest an alternative.
 *
 * Instead, this is run as a build step during `make build` (and
 * before any other relevant command); it explicitly lists the js/ext
 * directory and maintains a one-to-one list in js/worker-config.js.
 *
 * In effect, the require config is still as messy as before, but less
 * error-prone than having to fiddle around with paths too much.
 * There's a comment in js/worker-config.js explaining which lines are
 * automatically generated.
 */

var fs = require('fs');
var path = require('path');

// The directory to grab dependencies from:
var EXT_DIR = path.join(__dirname, '../js/ext');
var GELAM_LOADER = path.join(__dirname, '../js/worker-config.js');

// Get a list of module names within $GELAM/js/ext, non-recursively,
// and strip the extension if we're looking at a file (as opposed to a
// directory).
var deps = fs.readdirSync(EXT_DIR)
      .map(function(filename) {
        // Strip off the .js when needed since that's how RequireJS rolls.
        if (fs.lstatSync(path.join(EXT_DIR, filename)).isDirectory() ||
            filename.substr(-3) !== '.js') {
          return filename;
        } else {
          return filename.replace(/\.js$/, '');
        }
      })
      .filter(function(filename, index, self) {
        // Remove files starting with a period, and ensure only
        // unique names in the list.
        return !/^\./.test(filename) && self.indexOf(filename) === index;
      });

function replaceInFile(f, regex, replacement) {
  var enc = { encoding: 'utf8' };
  // Node < v0.10 accepts encoding only:
  if (parseInt(process.version.split('.')[1]) < 10) {
    enc = enc.encoding;
  }
  var contents = fs.readFileSync(f, enc);
  fs.writeFileSync(f, contents.replace(regex, replacement));
}

console.log('Updating js/ext module references in ' + GELAM_LOADER);

// Prettily insert the list of modules alphabetically, so that the
// loader file only changes when dependencies actually change. It's
// slightly ugly here in the spirit of properly rendering the whitespace.
deps.sort();
replaceInFile(GELAM_LOADER,
              /(<gelam-ext>.*?\n)([\s\S]*?)([ ]*\/\/ <\/gelam-ext>)/mg,
              '$1' + deps.map(function(module) {
                return "      '%s': 'ext/%s'".replace(/%s/g, module);
              }).join(',\n') + '\n$3');

// And, that's it.
