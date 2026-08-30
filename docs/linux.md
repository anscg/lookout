# Lookout on Linux

## Updates come from apt, not from the app

The in-app updater is off on Linux on purpose — `latest.json` lists macOS and
Windows only, so `check()` never finds anything. A package installed by a
package manager should be updated by that package manager, not by the app
reaching for `pkexec`.

Instead the `.deb` enrolls the machine in Lookout's apt repository as it
installs, the same way Chrome's package does, and `apt upgrade` takes it from
there. Installing the `.deb` from the releases page is all you need to do.

## Install

```bash
sudo apt install ./Lookout_linux-*_amd64.deb
```

`apt install ./file.deb` rather than `dpkg -i` — Lookout depends on several
GStreamer packages for screen capture and encoding, and only apt will pull
them in.

That install writes `/etc/apt/sources.list.d/lookout.sources` and
`/usr/share/keyrings/lookout-archive-keyring.asc`. Every later version arrives
through `apt upgrade`.

### Adding the repository by hand

If you would rather enroll first and install from the repository:

```bash
sudo install -d /usr/share/keyrings
sudo curl -fsSL -o /usr/share/keyrings/lookout-archive-keyring.asc \
  https://apt.lookout.hackclub.com/lookout-archive-keyring.asc
```

Check the key before trusting it — compare this fingerprint against the one
published wherever you got this document:

```bash
gpg --show-keys --with-fingerprint /usr/share/keyrings/lookout-archive-keyring.asc
```

Then:

```bash
sudo tee /etc/apt/sources.list.d/lookout.sources >/dev/null <<'EOF'
Types: deb
URIs: https://apt.lookout.hackclub.com
Suites: ./
Signed-By: /usr/share/keyrings/lookout-archive-keyring.asc
EOF
sudo apt update && sudo apt install lookout
```

amd64 and arm64 are both published.

## Opting out of the repository

Delete the sources file and it stays deleted — the package records that it has
enrolled once and will not put the file back on a later upgrade:

```bash
sudo rm /etc/apt/sources.list.d/lookout.sources
```

To opt out *before* installing, so the `.deb` never adds it in the first place:

```bash
echo 'repo_add_once=false' | sudo tee /etc/default/lookout
```

`apt purge lookout` removes the sources file, the keyring, and the marker.

## Fedora, Arch, and everyone else

No dnf repository or AUR package yet, so `.rpm` and `.pkg.tar.zst` from the
[releases page](https://github.com/hackclub/lookout/releases) are manual
installs and manual updates. The app won't prompt you.

## Maintaining the repository

The repository is a flat one — `Packages` and `InRelease` at the site root,
`.deb` files under `pool/` — built from scratch by the `apt` job in
`release.yml` on every tag and deployed to GitHub Pages.

A Pages deploy replaces the whole site, so `pool/` is rebuilt on every run:
the current release comes from the build artifacts, and the previous four from
their GitHub release assets. Keeping the last five bounds the site at roughly
140 MB — well under the 1 GB Pages limit — and means a wiped site heals on the
next release rather than quietly losing versions.

Keeping old versions matters for more than rollbacks. Someone who ran
`apt update` before a release and `apt upgrade` after it has a cached index
pointing at the previous `.deb`, and would hit a 404 if it disappeared. It also
keeps pinning working:

```bash
sudo apt install lookout=0.3.10
```

Change `KEEP` in the `apt` job to keep more or fewer.

The signing key is generated once by
[`scripts/apt-keygen.sh`](../scripts/apt-keygen.sh). Its public half lives at
`clients/desktop/src-tauri/linux/lookout-archive-keyring.asc` and is committed
deliberately: it ships inside the `.deb` as the `Signed-By` keyring, and
having it in git is what lets a locally built package enroll correctly. The
private half lives only in repository secrets.

Rotating that key is disruptive: an enrolled machine has the old public half
pinned on disk and only learns a new one from a newer `.deb`, which it would
have to fetch from the repository it can no longer verify. Protect the private
key rather than rotating it.

Required repository secrets — just the two, since Pages needs no credentials
of its own:

| Secret | Used by |
| --- | --- |
| `APT_GPG_PRIVATE_KEY` | signing `InRelease` |
| `APT_GPG_PASSPHRASE` | signing `InRelease` |

### One-time Pages setup

1. Settings → Pages → Source: **GitHub Actions**.
2. Settings → Pages → Custom domain: `apt.lookout.hackclub.com`, and tick
   Enforce HTTPS once the certificate is issued.
3. DNS: `CNAME apt.lookout → hackclub.github.io`.

The workflow writes a `CNAME` file into the deploy as well, so the domain
survives redeploys.

Note that Pages sets its own `Cache-Control` (10 minutes) and it can't be
overridden. That's tolerable here because a deploy purges the CDN and swaps
the site atomically, so the index and the packages it references always go
live together.

After the first deploy, smoke-test it on a machine that has never had the
repository:

```bash
sudo apt update && apt-cache policy lookout
```

Two CI guards, because both failures are silent and both freeze every Linux
user on one version:

- a tagged Linux build fails if the shipped keyring is still a placeholder,
  which would ship a package that installs fine and never updates;
- the `apt` job refuses to publish if the key inside the `.deb` isn't the key
  signing the index, which would turn every `apt update` into `NO_PUBKEY`.
