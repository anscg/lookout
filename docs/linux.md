# Lookout on Linux

## Updates come from your package manager

The in-app updater is off on Linux on purpose — `latest.json` lists macOS and
Windows only, so `check()` never finds anything. A package installed by a
package manager should be updated by that package manager, not by the app
reaching for `pkexec`.

So each package enrols the machine in the right repository as it installs, the
way Chrome's does, and normal system updates carry you forward. Installing from
the releases page is all you need to do.

If a newer version is out and you haven't taken it, the app says so and shows
the exact command for however you installed — it detects that rather than
guessing.

## One line

```bash
curl -fsSL https://lookout.hackclub.com/install.sh | sh
```

Works on apt, dnf, zypper and pacman. It prints what it will do and waits for
confirmation; `-y` skips the prompt, and it refuses to run unattended without
it rather than assuming consent.

## Debian and Ubuntu

```bash
sudo apt install ./Lookout_linux-*_amd64.deb
```

`apt install ./file.deb` rather than `dpkg -i` — Lookout depends on several
GStreamer packages for capture and encoding, and only apt will pull them in.

That writes `/etc/apt/sources.list.d/lookout.sources`, and every later version
arrives through `apt upgrade`.

### Adding the repository by hand

```bash
sudo install -d /usr/share/keyrings
sudo curl -fsSL -o /usr/share/keyrings/lookout-archive-keyring.asc \
  https://pkg.lookout.hackclub.com/lookout-archive-keyring.asc
```

Check the key before trusting it:

```bash
gpg --show-keys --with-fingerprint /usr/share/keyrings/lookout-archive-keyring.asc
```

```bash
sudo tee /etc/apt/sources.list.d/lookout.sources >/dev/null <<'EOF'
Types: deb
URIs: https://pkg.lookout.hackclub.com/deb
Suites: ./
Signed-By: /usr/share/keyrings/lookout-archive-keyring.asc
EOF
sudo apt update && sudo apt install lookout
```

Requires Ubuntu 24.04+ or Debian 13+ — the package declares `libc6 (>= 2.39)`,
which is the glibc it is built against, so an older release refuses it cleanly
instead of installing something that cannot start.

## Fedora and RHEL

```bash
sudo dnf install ./Lookout_linux-*_x86_64.rpm
```

That writes `/etc/yum.repos.d/lookout.repo`, and `dnf upgrade` handles the
rest. By hand:

```bash
sudo rpm --import https://pkg.lookout.hackclub.com/lookout-archive-keyring.asc
sudo tee /etc/yum.repos.d/lookout.repo >/dev/null <<'EOF'
[lookout]
name=Lookout
baseurl=https://pkg.lookout.hackclub.com/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://pkg.lookout.hackclub.com/lookout-archive-keyring.asc
EOF
sudo dnf install lookout
```

## Arch

Arch is the one that isn't self-enrolling: a package editing `pacman.conf` is
considered rude in a way a Debian postinst isn't, so the repository is added by
hand once.

```bash
curl -fsSL https://pkg.lookout.hackclub.com/lookout-archive-keyring.asc \
  | sudo pacman-key --add -
sudo pacman-key --lsign-key 1A6D22590D34B83E2D0B3C8DF4806E984D9DA365

sudo tee -a /etc/pacman.conf >/dev/null <<'EOF'

[lookout]
Server = https://pkg.lookout.hackclub.com/arch/$arch
EOF

sudo pacman -Sy lookout-bin
```

After that `pacman -Syu` updates it with everything else.

The AUR would be the more idiomatic route, and `packaging/aur/` plus the `aur`
workflow are ready for it — but AUR registration is closed to new accounts, so
the repository is what exists today. Both channels use the same package name,
so a machine with the repository configured takes the prebuilt package and one
without it can still build `lookout-bin` from the AUR once that opens.

## The command is `lookout`

`lookout-desktop` also works — the packages symlink the old name to the new one
so existing scripts and launchers keep working.

## Opting out of the repository

Delete the file and it stays deleted; the package will not put it back:

```bash
sudo rm /etc/apt/sources.list.d/lookout.sources   # or /etc/yum.repos.d/lookout.repo
```

To opt out *before* installing:

```bash
echo 'repo_add_once=false' | sudo tee /etc/default/lookout
```

Purging removes the repository file, the key, and the marker.

## Maintaining the repositories

`pkg.lookout.hackclub.com` is one GitHub Pages site holding both:

| Path | What |
| --- | --- |
| `/deb` | flat apt repository — `Packages` and `InRelease` at that level, packages under `pool/` |
| `/rpm` | dnf repository — `repodata/` plus the signed rpms |
| `/arch/$arch` | pacman repository — `lookout.db` plus the signed packages, split by architecture |
| `/lookout-archive-keyring.asc` | the public key for both |

The `packages` workflow builds both from the GitHub release assets and deploys
them together. Pages allows one custom domain and replaces the whole site per
deploy, which is why they share a host and cannot be published independently.

It can be run by hand at any time (`workflow_dispatch`), so bringing a
repository up or repairing an index does not need a tag. Both are rebuilt from
scratch each run, from releases rather than from whatever is currently
deployed, so a wiped site heals on the next run. The last five releases are
kept, which bounds the site and keeps `apt install lookout=<version>` working —
and means an index someone cached before a release still points at a package
that exists.

`aur` is manual only and deliberately not part of a release: with AUR
registration closed there is no account to push as, so wiring it in would fail
every tag. It renders `packaging/aur/PKGBUILD.in` against a release and pushes
`lookout-bin`, with `.SRCINFO` generated by `makepkg` inside an Arch container
rather than written by hand so it cannot drift from the PKGBUILD. Run it once
an account exists.

### Signing

One key, generated once by [`scripts/apt-keygen.sh`](../scripts/apt-keygen.sh),
signs both repositories. Its public half is committed at
`clients/desktop/src-tauri/linux/lookout-archive-keyring.asc` on purpose: it
ships inside the packages as the trusted key, and having it in git is what lets
a locally built package enrol correctly.

dnf verifies signatures on the *packages*, not just the metadata, so the
workflow re-signs each rpm with `rpmsign` before indexing — they come off the
releases unsigned — and then reads each signature back with only the public
half, because `rpmsign` reports success on things dnf later rejects.

pacman wants a detached *binary* signature beside each package, not an armored
one, and `SigLevel = Required` turns an unverifiable signature into a hard
failure on every upgrade rather than a warning. So those are read back with the
public half too.

Rotating the key is disruptive: an enrolled machine has the old public half
pinned on disk and only learns a new one from a newer package, which it would
have to fetch from the repository it can no longer verify. Protect the private
key rather than rotating it.

### Secrets

| Secret | Used by |
| --- | --- |
| `APT_GPG_PRIVATE_KEY` | signing `InRelease`, `repomd.xml`, and the rpms |
| `APT_GPG_PASSPHRASE` | the same |
| `AUR_SSH_PRIVATE_KEY` | pushing to the AUR — only needed to run `aur` by hand |

### One-time setup

1. Settings → Pages → Source: **GitHub Actions**; custom domain
   `pkg.lookout.hackclub.com`, Enforce HTTPS once the certificate issues.
2. DNS: `CNAME pkg.lookout → hackclub.github.io`.
3. The AUR needs nothing today — the `aur` workflow is manual and unused.
   Whenever registration reopens: create `lookout-bin` under a Hack Club AUR
   account, add an SSH key, and put the private half in `AUR_SSH_PRIVATE_KEY`.
   The workflow pins the AUR's host key rather than trusting it on first use,
   so if the AUR rotates it the push fails closed and `AUR_HOST_KEY_FPR` in
   `aur.yml` needs updating against the published value.

Pages sets its own `Cache-Control` (10 minutes) and it can't be overridden.
That's fine here because a deploy purges the CDN and swaps the site atomically,
so an index and the packages it references always go live together.

### Guards

Three, because each failure is silent and each one freezes Linux users on one
version:

- a tagged Linux build fails if the shipped keyring is still a placeholder,
  which would ship a package that installs fine and never updates;
- the publish refuses if the key inside a package isn't the key signing the
  index, which would turn every `apt update` into `NO_PUBKEY`;
- the clean-Ubuntu check asserts the binary is `/usr/bin/lookout` with the
  alias beside it, since `mainBinaryName` failing to apply breaks nothing at
  build time — it just ships a package whose command isn't the documented one.
