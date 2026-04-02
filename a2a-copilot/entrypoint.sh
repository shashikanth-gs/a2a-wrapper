#!/bin/sh
# =============================================================================
# entrypoint.sh — A2A GitHub Copilot Wrapper
# =============================================================================
#
# Handles TLS certificate injection for corporate proxy environments
# (e.g. Netskope, Zscaler), then hands off to the Node.js CLI.
#
# Corporate proxy CA support:
#   Mount your CA cert into the container at /etc/ssl/certs/corporate-ca.crt
#   and this script will:
#     1. Merge it with the system CA bundle for native binaries (SSL_CERT_FILE)
#     2. Inject it into Node.js TLS verification (NODE_EXTRA_CA_CERTS)
#
# All CLI arguments are forwarded to dist/cli.js unchanged.
# =============================================================================

if [ -f /etc/ssl/certs/corporate-ca.crt ]; then
  cat /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/corporate-ca.crt \
    > /tmp/combined-ca-bundle.crt
  export SSL_CERT_FILE=/tmp/combined-ca-bundle.crt
  export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corporate-ca.crt
fi

exec node dist/cli.js "$@"
