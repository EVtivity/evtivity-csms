# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately. Do not open a public issue.

**Email:** evtivity@gmail.com

Include:

- Description of the vulnerability
- Steps to reproduce
- Affected version(s)
- Impact assessment if known

We aim to acknowledge reports within 48 hours and provide a fix or mitigation within 7 days for critical issues.

## Security Practices

- All dependencies are audited on every CI run (`npm audit --audit-level=high`)
- User-provided templates are sanitized before compilation (Handlebars block helpers, partials, and subexpressions are blocked)
- Passwords are hashed with argon2
- API keys and secrets are encrypted at rest with AES-256-GCM
- CSRF protection on all mutating cookie-authenticated requests
- Rate limiting on authentication and sensitive endpoints
- RBAC permission enforcement on all operator API routes
- TLS support with optional mTLS for OCPP station connections (SP3)

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will credit the reporter (unless they prefer to remain anonymous) in the release notes.
