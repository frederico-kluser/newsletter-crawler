# Security Policy

Security is a first-class concern for **newsletter-crawler** (`frederico-kluser/newsletter-crawler`). Thank you for
helping keep the project and its users safe.

## Supported Versions

Only the latest release line receives security fixes. Please upgrade before reporting issues that
may already be fixed.

| Version            | Supported          |
| ------------------ | ------------------ |
| Latest release (`main`) | :white_check_mark: |
| Previous minor (n-1) | :white_check_mark: (best effort) |
| Older versions     | :x:                |

## Reporting a Vulnerability

**Do not report security vulnerabilities through public issues, discussions, or pull requests.**

We use GitHub **Private Vulnerability Reporting**:

1. Open the repository's **Security** tab → **Advisories** → **Report a vulnerability**
   (<https://github.com/frederico-kluser/newsletter-crawler/security/advisories/new>).

Please include, whenever possible:

- Description of the vulnerability and its potential impact.
- Step-by-step reproduction or a proof of concept.
- Affected versions/commit hashes and, if known, the introducing commit.
- Any suggested fix or mitigation.

### Our SLA

| Milestone                                | Target                      |
| ---------------------------------------- | --------------------------- |
| Acknowledgement of your report           | **48 hours**                |
| Triage and initial severity assessment   | **3 business days**         |
| Status updates                           | every **7 days**            |
| Fix or mitigation for critical findings  | **30 days**                 |
| Fix or mitigation for other findings     | **90 days**                 |

If a report is out of scope or not accepted, we will explain why and, where relevant, point you to
the appropriate channel.

## Coordinated Disclosure

- Please keep the vulnerability **confidential** until a fix is released and a public advisory is
  published.
- We will work with you on a disclosure date, credit you in the advisory (unless you prefer to
  remain anonymous), and notify you when the fix ships.
- **Embargo**: up to **90 days** from acknowledgement; we will never extend an embargo without your
  agreement and will always aim to disclose as soon as a fix is available.
- Once a fix is released, we publish a GitHub Security Advisory (CVE when applicable) and a release
  note referencing the fix.

## Scope

In scope:

- The `newsletter-crawler` codebase, its published packages, and the build/release pipelines of this
  repository.

Out of scope (report to the relevant vendor instead):

- Vulnerabilities in third-party dependencies with an existing upstream advisory.
- Issues exclusively affecting unsupported versions.
- Social engineering, physical attacks, and denial of service against GitHub or third-party
  infrastructure.

## Hardening

The project maintains the following supply-chain protections; keep them enabled:

- **Secret scanning** and **push protection** (GitHub secret scanning) to prevent credential leaks.
- **Dependabot** alerts and version updates for vulnerable dependencies.
- **Branch protection / rulesets** on `main`: 2 required approvals, code owner review,
  required status checks, squash-only merges, and immutable `v*` tags.
- **OpenSSF Scorecard** monitoring (`scorecard.yml`) with published results.
- **Pinned GitHub Actions** (`owner/repo@<PIN_SHA>`) so that third-party action tags cannot be
  moved underneath us.

## Contact

- Security contact: **GitHub Private Vulnerability Reporting** (<https://github.com/frederico-kluser/newsletter-crawler/security/advisories/new>)
- Public non-security questions: use GitHub issues/discussions in `frederico-kluser/newsletter-crawler`.
