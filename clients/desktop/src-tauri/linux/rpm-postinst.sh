#!/bin/sh
# The rpm counterpart of postinst.sh: adds Lookout's dnf repository so
# `dnf upgrade` picks up new versions.
#
# rpm scriptlet arguments are counts, not verbs: %post gets 1 on a fresh
# install and 2 on an upgrade, so >= 1 covers both.

set -e

REPO_URL="https://pkg.lookout.hackclub.com/rpm"
PACKAGED_KEY="/usr/share/lookout/lookout-archive-keyring.asc"
# Copied out rather than shipped at this path directly: if rpm owned it,
# erasing the package would take the key with it while the .repo file
# remained, and every later dnf call would fail on a missing gpgkey.
KEYRING="/etc/pki/rpm-gpg/RPM-GPG-KEY-lookout"
REPO_FILE="/etc/yum.repos.d/lookout.repo"
DEFAULTS="/etc/default/lookout"
MARKER="/var/lib/lookout/repo-added"
# The binary used to be installed as lookout-desktop; keep that name working.
LEGACY_ALIAS="/usr/bin/lookout-desktop"

repo_add_once=true
if [ -r "$DEFAULTS" ]; then
  . "$DEFAULTS"
fi

enroll() {
  case "$repo_add_once" in
    false|no|0|"") return 0 ;;
  esac

  # Local builds ship a placeholder instead of the key; a gpgkey pointing at
  # that would break every dnf transaction.
  if ! grep -q "BEGIN PGP PUBLIC KEY BLOCK" "$PACKAGED_KEY" 2>/dev/null; then
    echo "lookout: no repository key in package -- skipping dnf enrollment" >&2
    return 0
  fi

  # Added once, so deleting the .repo file makes it stay deleted.
  if [ -e "$MARKER" ]; then
    return 0
  fi

  install -d -m 0755 /etc/pki/rpm-gpg
  install -m 0644 "$PACKAGED_KEY" "$KEYRING"
  rpm --import "$KEYRING" 2>/dev/null || true

  install -d -m 0755 /etc/yum.repos.d
  cat > "$REPO_FILE" <<EOF
# Added by the lookout package. Delete it to stop receiving updates; it will
# not come back. To opt out before installing, put repo_add_once=false in
# /etc/default/lookout.
[lookout]
name=Lookout
baseurl=$REPO_URL
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=file://$KEYRING
EOF
  chmod 0644 "$REPO_FILE"

  install -d -m 0755 /var/lib/lookout
  : > "$MARKER"

  echo "lookout: added $REPO_URL to dnf repositories"
}

alias_legacy_name() {
  [ -x /usr/bin/lookout ] || return 0
  [ -e "$LEGACY_ALIAS" ] && [ ! -L "$LEGACY_ALIAS" ] && return 0
  ln -sf lookout "$LEGACY_ALIAS"
}

if [ "$1" -ge 1 ] 2>/dev/null; then
  # The `|| true` suppresses errexit inside enroll(); a failing scriptlet
  # leaves the transaction looking broken.
  enroll || true
  alias_legacy_name || true
fi

exit 0
