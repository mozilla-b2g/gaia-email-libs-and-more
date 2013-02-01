var fs = require('fs'),
    jsmin = require('./jsmin2/jsmin');

function usage(why) {
  console.log('error:', why);
  console.log('');
  console.log('you typed:', process.argv);
  console.log('');
  console.log('usage: node run-jsmin2.js INFILE OUTFILE');
  process.exit(1);
}

// if only we could compensate!
if (!/\/run-jsmin2.js$/.test(process.argv[1]))
  usage('not run the right way; no hash-bang!');

if (process.argv.length !== 4)
  usage('not enough args');

var inSrc = fs.readFileSync(process.argv[2], 'utf8');

var minResult = jsmin(inSrc);

var outSrc = minResult.code;

fs.writeFileSync(process.argv[3], outSrc, 'utf8');
