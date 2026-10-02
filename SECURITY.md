# Security

Spark Scope is a read-only monitor without authentication. The README's [Security](README.md#security) section explains what it exposes and how to run it safely: keep it on localhost or a network you trust, and put an authenticating reverse proxy in front of it if it must be reached from elsewhere.

## Reporting a problem

Please report a vulnerability privately through GitHub: the repository's **Security** tab, **Report a vulnerability**. If that button is not there, open an issue that only says you have a security report and asks for a private contact, without any details.

Useful to include: the version or commit, how the dashboard is reached (localhost, LAN, Tailscale, a proxy) and the steps that show the problem.

## Supported versions

Fixes go into `main` and the next release. Older releases are not patched.
