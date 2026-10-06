#!/bin/sh
# dapweb installer: the README's curl | tar one-liner, behind a short URL.
# Unpacks into ./dapweb-<platform> in the current directory, nothing else.
set -e
os=$(uname -s | tr A-Z a-z)
arch=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
p="$os-$arch"
url="https://github.com/milo-language/dapweb/releases/download/latest/dapweb-$p.tar.gz"
echo "downloading dapweb for $p"
curl -fsSL "$url" | tar xz
echo ""
echo "installed: ./dapweb-$p/dapweb"
echo "try it:    ./dapweb-$p/dapweb /path/to/your-program"
