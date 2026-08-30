#!/bin/sh
# Lookout installer.  curl -fsSL https://lookout.hackclub.com/install.sh | sh
#
# Adds the Lookout package repository for whichever package manager this
# machine uses, then installs from it, so future versions arrive with the rest
# of your system updates.
set -eu

HOST="https://pkg.lookout.hackclub.com"
KEY_URL="$HOST/lookout-archive-keyring.asc"
KEY_FPR="1A6D22590D34B83E2D0B3C8DF4806E984D9DA365"
RELEASES="https://github.com/hackclub/lookout/releases/latest"

ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help)
      echo "Usage: install.sh [-y]"
      echo "  -y, --yes   don't ask before making changes"
      exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  b=$(printf '\033[1m'); dim=$(printf '\033[2m'); r=$(printf '\033[0m')
else
  b=''; dim=''; r=''
fi

die() { printf '%s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have curl || die "curl is required, but isn't installed."

case "$(uname -s)" in
  Linux) ;;
  Darwin) die "This installer is for Linux. On macOS, download the .dmg from $RELEASES" ;;
  *) die "Unsupported system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64|amd64|aarch64|arm64) ;;
  *) die "No packages for $(uname -m). See $RELEASES" ;;
esac

# Ordered so a machine with more than one of these gets its primary. Fedora
# still ships yum as a symlink, and openSUSE has rpm without dnf.
if   have apt-get; then MGR=apt;    PKG=lookout
elif have dnf;     then MGR=dnf;    PKG=lookout
elif have zypper;  then MGR=zypper; PKG=lookout
elif have pacman;  then MGR=pacman; PKG=lookout-bin
else
  die "No supported package manager found (apt, dnf, zypper or pacman).
Download a package directly from $RELEASES"
fi

if [ "$(id -u)" = 0 ]; then
  SUDO=''
else
  have sudo || die "This needs root, but sudo isn't installed. Re-run as root."
  SUDO='sudo'
fi

case "$MGR" in
  apt)    where="/etc/apt/sources.list.d/lookout.sources" ;;
  dnf)    where="/etc/yum.repos.d/lookout.repo" ;;
  zypper) where="a zypper repository named 'lookout'" ;;
  pacman) where="a [lookout] section in /etc/pacman.conf" ;;
esac

printf '\n%sLookout%s\n\n' "$b" "$r"
printf 'This will:\n'
printf '  • add %s to %s\n' "$HOST" "$where"
printf '  • trust the signing key %s\n' "$KEY_FPR"
printf '  • install %s with %s\n' "$PKG" "$MGR"
printf '\n%sUpdates then arrive with the rest of your system updates.%s\n' "$dim" "$r"
printf '%sNothing else is changed. Uninstall with your package manager.%s\n\n' "$dim" "$r"

if [ "$ASSUME_YES" = 0 ]; then
  # Probed in a subshell: a failed `exec` redirection exits a non-interactive
  # shell outright, so testing it inline would skip the message below. And not
  # with `[ -r /dev/tty ]`, which passes under `curl | sh` even where the open
  # fails — leaving the reply empty, which is what pressing Enter also means.
  # Consent has to come from a read that actually happened.
  if ! (exec 3</dev/tty) 2>/dev/null; then
    die "Can't ask for confirmation without a terminal. Re-run with -y:
  curl -fsSL https://lookout.hackclub.com/install.sh | sh -s -- -y"
  fi
  printf 'Continue? [Y/n] '
  read -r reply < /dev/tty || reply=n
  case "$reply" in
    ''|y|Y|yes|Yes|YES) ;;
    *) echo "Cancelled."; exit 0 ;;
  esac
  echo
fi

step() { printf '%s==>%s %s\n' "$b" "$r" "$1"; }

key=$(mktemp)
trap 'rm -f "$key"' EXIT
step "Fetching the signing key"
curl -fsSL "$KEY_URL" -o "$key"

# Pinned against the fingerprint compiled into this script, so a key swapped
# out on the server alone doesn't get trusted. Only possible where gpg exists;
# apt and rpm both consume the key without it.
if have gpg; then
  got=$(gpg --show-keys --with-colons "$key" 2>/dev/null | awk -F: '/^fpr:/ {print $10; exit}')
  [ "$got" = "$KEY_FPR" ] || die "Signing key is $got, expected $KEY_FPR. Not continuing."
  step "Key verified"
else
  printf '%s    gpg not installed, skipping the fingerprint check%s\n' "$dim" "$r"
fi

case "$MGR" in
  apt)
    step "Adding the apt repository"
    $SUDO install -d -m 0755 /usr/share/keyrings
    $SUDO install -m 0644 "$key" /usr/share/keyrings/lookout-archive-keyring.asc
    $SUDO install -d -m 0755 /etc/apt/sources.list.d
    printf 'Types: deb\nURIs: %s/deb\nSuites: ./\nSigned-By: /usr/share/keyrings/lookout-archive-keyring.asc\n' \
      "$HOST" | $SUDO tee /etc/apt/sources.list.d/lookout.sources >/dev/null
    step "Installing"
    $SUDO apt-get update
    $SUDO apt-get install -y "$PKG"
    ;;
  dnf|zypper)
    step "Adding the repository"
    $SUDO rpm --import "$key"
    $SUDO install -d -m 0755 /etc/yum.repos.d
    printf '[lookout]\nname=Lookout\nbaseurl=%s/rpm\nenabled=1\ngpgcheck=1\nrepo_gpgcheck=1\ngpgkey=%s\n' \
      "$HOST" "$KEY_URL" | $SUDO tee /etc/yum.repos.d/lookout.repo >/dev/null
    step "Installing"
    if [ "$MGR" = dnf ]; then
      $SUDO dnf install -y "$PKG"
    else
      $SUDO zypper --non-interactive refresh lookout
      $SUDO zypper --non-interactive install "$PKG"
    fi
    ;;
  pacman)
    step "Trusting the key"
    $SUDO pacman-key --add "$key"
    $SUDO pacman-key --lsign-key "$KEY_FPR"
    step "Adding the repository"
    # Appending twice would make pacman complain on every operation.
    if grep -q '^\[lookout\]' /etc/pacman.conf; then
      printf '%s    already in /etc/pacman.conf%s\n' "$dim" "$r"
    else
      printf '\n[lookout]\nServer = %s/arch/$arch\n' "$HOST" | $SUDO tee -a /etc/pacman.conf >/dev/null
    fi
    step "Installing"
    $SUDO pacman -Sy --noconfirm "$PKG"
    ;;
esac

printf '\n%sInstalled.%s Run %slookout%s, or find it in your applications menu.\n\n' "$b" "$r" "$b" "$r"
