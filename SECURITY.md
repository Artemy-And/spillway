# Security Policy

Spillway holds every provider API key of the company that runs it and sees every prompt, so
security reports get priority over everything else.

## Supported versions

Security fixes go into the latest release only. Please update before reporting.

## Reporting a vulnerability

Do not open a public issue.

Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository.
Include the version, steps to reproduce and what an attacker could do with it.

You will get a reply within 7 days. Once a fix is released, the advisory is published and
reporters are credited unless they ask not to be.

## Scope

In scope:

- the gateway endpoints, the admin UI and its API
- sign-in: passwords, sessions, invitation links and single sign-on
- provider API keys: their encryption at rest and anything that leaks them through logs, errors or
  the UI
- keys and budgets: reaching a model or spending money that a key's limits should not allow
- personal data rules: getting data a rule should keep away from cloud models past it, or into the
  stored log unmasked
- the published Docker images and `docker-compose.yml`

Out of scope: vulnerabilities in model providers or in Ollama itself, findings that need an already
compromised host, and personal data formats Spillway does not claim to detect (the README lists the
ones it does).

Release images are signed and carry an SBOM and build provenance; see
[Verify the image](README.md#verify-the-image).
