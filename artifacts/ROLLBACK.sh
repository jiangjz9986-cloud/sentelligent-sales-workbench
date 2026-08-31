#!/bin/sh
set -eu
src=${1:?source copy required}
out=${2:?rollback copy required}
cp "$src" "$out"
printf 'ROLLBACK_RESULT=restored-copy\n'
