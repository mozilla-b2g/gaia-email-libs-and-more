#!/usr/bin/python

# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this file,
# You can obtain one at http://mozilla.org/MPL/2.0/.

from argparse import ArgumentParser
from shutil import rmtree
from subprocess import Popen
from sys import argv
from sys import exit
from tempfile import mkdtemp
from os.path import abspath

DEFAULT_PORT = 8080
DEFAULT_HOSTNAME = 'localhost'

def run_server(b2gsrcdir, b2gobjdir, gelamsrcdir, js_file,
               hostname=DEFAULT_HOSTNAME, port=DEFAULT_PORT):

    dist_dir = '%s/dist' % b2gobjdir

    args = [
        '%s/bin/xpcshell' % dist_dir,
        '-g', '%s/bin' % dist_dir,
        '-a', '%s/bin' % dist_dir,
        '-r', '%s/bin/components/httpd.manifest' % dist_dir,
        '-m',
        '-n',
        '-s',
        '-f', '%s/testing/xpcshell/head.js' % b2gsrcdir,
        '-e', 'const _SERVER_ADDR = "%s";' % hostname,
        '-e', 'const _TESTING_MODULES_DIR = "%s/_tests/modules";' % b2gobjdir,
        '-e', 'const SERVER_PORT = "%s";' % port,
        '-e', '_register_protocol_handlers();',
        '-e', '_fakeIdleService.activate();',
        '-f', '%s/test/%s' % (gelamsrcdir, js_file)
    ]

    profile_dir = mkdtemp()
    print 'Created profile directory: %s' % profile_dir

    try:
        env = {'XPCSHELL_TEST_PROFILE_DIR': profile_dir,
               'LD_LIBRARY_PATH': '%s/bin' % dist_dir}
        proc = Popen(args, env=env)

        return proc.wait()

    finally:
        print 'Removing profile directory %s' % profile_dir
        rmtree(profile_dir)

if __name__ == '__main__':
    parser = ArgumentParser(description="Run a standalone JS server.")
    parser.add_argument('b2gsrcdir',
        help="Root directory of B2G source code.")
    parser.add_argument('b2gobjdir',
        help="Root object directory created during build.")
    parser.add_argument('gelamsrcdir',
        help="Root directory of GELAM source code.")
    parser.add_argument('js_file',
        help="JS file (relative to this directory) to execute.")
    parser.add_argument('--port', default=DEFAULT_PORT, type=int,
        help="Port to run server on.")
    parser.add_argument('--address', default=DEFAULT_HOSTNAME,
        help="Hostname to bind server to.")

    args = parser.parse_args()

    exit(run_server(abspath(args.b2gsrcdir), abspath(args.b2gobjdir),
                    abspath(args.gelamsrcdir), args.js_file, args.address,
                    args.port))
