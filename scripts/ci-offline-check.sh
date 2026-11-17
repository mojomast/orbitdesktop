#!/bin/bash
# Hosted Ubuntu disables unprivileged network namespaces. Create just the
# namespace as root, then run the checked-out code as the original runner.
set -euo pipefail
user_id=$(id -u); group_id=$(id -g); node_bin=$(command -v node)
inputs=()
if [[ ${ORBIT_TEST_PROVISIONED:-0} == 1 ]]; then
  inputs+=(ORBIT_TEST_PROVISIONED=1)
  for key in HERMES_NATIVE_SOURCE HERMES_PINNED_SOURCE HERMES_PINNED_PYTHON ORBIT_ROUTETOK_TEST_SOURCE ORBIT_ROUTETOK_TEST_CACHE; do
    [[ -z ${!key:-} ]] || inputs+=("$key=${!key}")
  done
fi
sudo /usr/bin/unshare --net -- /bin/sh -ec '
  /usr/bin/ip link set lo up
  uid=$1; gid=$2; shift 2
  exec /usr/bin/setpriv --reuid="$uid" --regid="$gid" --init-groups -- /usr/bin/env -i "$@"
' -- "$user_id" "$group_id" "HOME=$HOME" PATH=/usr/bin:/bin "${inputs[@]}" "$node_bin" scripts/check-local.mjs check
