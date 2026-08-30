#!/bin/sh
# Undoes postinst.sh. Only remove/purge: an upgrade calls the old package's
# postrm with `upgrade`, and tearing the repo down mid-update would be wrong.
set -e

KEYRING="/usr/share/keyrings/lookout-archive-keyring.asc"
SOURCES="/etc/apt/sources.list.d/lookout.sources"
MARKER="/var/lib/lookout/repo-added"

case "$1" in
  remove|purge)
    # Marker goes too, or a later reinstall would never re-enroll.
    rm -f "$SOURCES" "$KEYRING" "$MARKER" || true
    rmdir /var/lib/lookout 2>/dev/null || true
    ;;
esac

exit 0
