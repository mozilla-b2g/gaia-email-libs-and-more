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
      
echo 'Downloading and installing Mozilla Download'
npm install mozilla-download -g
    
echo 'Downloading B2G desktop client'
mozilla-download ./b2g --product b2g

echo 'Create the symlink to B2G desktop xulrunner'
ln -s ./b2g b2g-bindir-symlink
    
section_echo 'make all-tests'
make all-tests

TEST_RESULT=`cat ./test-logs/test-result.log`

if [ `echo $TEST_RESULT | grep -c "success" ` -gt 0 ]
then
  exit 0;
else
  exit 1;
fi
