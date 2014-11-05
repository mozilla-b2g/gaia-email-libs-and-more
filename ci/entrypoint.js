#! /usr/bin/env node

var requireTask = require('./lib/require_task');
var yaml = require('js-yaml');
var fs = require('fs');
var fsPath = require('path');
var format = require('util').format;
var ArgumentParser = require('argparse').ArgumentParser;

function requireYaml(path) {
  return yaml.load(fs.readFileSync(path));
}

var parser = new ArgumentParser({
  addHelp: true,
  description: 'CLI which builds the task graph for gelam'
});

parser.addArgument(['--local'], {
  action: 'storeTrue',
  help: 'Generate at task graph suitable for running with taskcluster run-graph'
});

parser.addArgument(['--tasks'], {
  help: 'path to tasks yml configuration',
  defaultValue: __dirname + '/tasks.yml'
})


var args = parser.parseArgs();
var tasks = requireYaml(args.tasks);
var tasksCwd = fsPath.dirname(args.tasks);
var graph = {};

// if submitting the graph directly rather then through extending an existing
// graph (as is the case for local testing) then we need to add some additional
// information.
if (args.local) {
  graph.scopes = [
    'queue:create-task:aws-provisioner/gaia',
    'queue:define-task:aws-provisioner/gaia'
  ];

  graph.metadata = {
    source: process.env.GITHUB_HEAD_GIT + '/blob/tests/taskcluster/bin/graph',
    owner: 'jlal@mozilla.com', // TODO: Obviously change this...
    description: 'Generated task graph for GELAM',
    name: 'GELAM'
  };
}

graph.tasks = Object.keys(tasks).map(function(taskName) {
  var config = tasks[taskName];
  var taskPath = fsPath.resolve(tasksCwd, config.task);
  // XXX: If we decide to add chunks or config we can do it here...
  return requireTask(format(taskPath));
});

console.log(JSON.stringify(graph, null, 2))
