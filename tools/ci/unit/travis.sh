#!/bin/bash

GREEN_COLOR=$(printf "\x1b[32;1m")
NORMAL_COLOR=$(printf "\x1b[0m")

function section_echo {
  echo ${GREEN_COLOR}$1${NORMAL_COLOR}
  echo ${GREEN_COLOR}`seq -s= $(expr ${#1} + 1)|tr -d '[:digit:]'`${NORMAL_COLOR}
}

section_echo 'Preparing test environment'

echo 'Initializing submodules for gaia-email-libs-and-more'
git submodule update --init --recursive

echo 'Downloading B2G desktop client'
make b2g

section_echo 'make all-tests'
make all-tests

if [ `grep -c "success" ./test-logs/last-run.summary` -gt 0 ]
then
  exit 0;
else
  exit 1;
fi
