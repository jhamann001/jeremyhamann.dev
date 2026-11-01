#!/bin/sh
# Refuses commits made with any identity other than the personal one.
expected="226341726+jhamann001@users.noreply.github.com"
actual=$(git config user.email)
if [ "$actual" != "$expected" ]; then
  echo "check-identity: commit email is '$actual', expected the personal address. Commit refused." >&2
  exit 1
fi
