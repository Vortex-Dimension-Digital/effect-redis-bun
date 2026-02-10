# Security Policy

## Supported Versions

We currently provide security support for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

The security of `effect-bun-redis` is a priority. If you discover a security vulnerability, please help us by following these guidelines:

### 🔒 Reporting Process

**DO NOT** open a public issue to report security vulnerabilities.

Instead, report privately through:

1. **GitHub Security Advisories** (recommended)
   - Go to the "Security" tab of the repository
   - Click "Report a vulnerability"
   - Complete the form with details

2. **Direct Email** (alternative)
   - Send an email to: contactodesarrollo@dimensionvortex.com
   - Subject: `[SECURITY] Brief description`
   - Include all details in the body

### 📋 Information to Include

To help us understand and resolve the issue quickly, include:

- **Type of vulnerability** (e.g., injection, XSS, authentication, etc.)
- **Location of affected code** (files, lines)
- **Affected version** of effect-bun-redis
- **Steps to reproduce** the problem
- **Potential impact** of the vulnerability
- **Suggested fix** (if you have one)
- **Your contact information** for follow-up

### 📧 Report Example

```
Type: Possible credential exposure
Location: src/index.ts, buildUrl() function
Version: 1.0.0

Description:
Passwords could be logged in certain contexts...

Reproduction:
1. Configure with password: "secret"
2. Call buildUrl()
3. Password appears in...

Impact:
An attacker with access to logs could...

Suggested Fix:
Redact passwords in URLs before logging
```

### ⏱️ What to Expect

- **Confirmation**: We'll respond within 48 hours acknowledging your report
- **Investigation**: We'll evaluate the report within 7 days
- **Update**: We'll keep you informed of progress
- **Resolution**: We'll work on a priority fix
- **Disclosure**: We'll coordinate public disclosure with you
- **Credit**: We'll give you credit in the advisory (if you wish)

### 🛡️ Disclosure Policy

We follow a **coordinated disclosure** policy:

1. You report the vulnerability privately
2. We confirm and validate the report
3. We develop and test a fix
4. We release a version with the patch
5. We publish a security advisory
6. We give you credit (if you accept)

**Typical timeframe**: 30-90 days depending on severity

### 🎖️ Acknowledgments

We thank the following security researchers:

<!-- List of security contributors -->
- No one yet - be the first!

### 🔍 Scope

**In scope:**
- Vulnerabilities in this library's code
- Configuration issues that expose data
- Bugs that allow authentication bypass
- Direct dependency vulnerabilities

**Out of scope:**
- Vulnerabilities in Redis Server itself
- Issues in Bun runtime (report to Bun)
- Vulnerabilities in Effect (report to Effect)
- Attacks requiring physical access
- Denial of service (DoS) attacks
- Issues in applications using the library

### 📚 Recommended Best Practices

To use this library securely:

- **Don't hardcode credentials** - use environment variables
- **Use TLS** in production - configure `tls: true`
- **Limit permissions** - use Redis users with ACLs
- **Validate inputs** - sanitize data before storing in Redis
- **Rotate credentials** regularly
- **Monitor access** - logs and alerts in production
- **Keep updated** - use the latest version
- **Review dependencies** - run `bun audit` regularly

### 🔐 Secure Configuration

```typescript
import { makeLayer } from "effect-bun-redis"

// ✅ Good: Credentials from env vars
const layer = makeLayer({
  host: process.env.REDIS_HOST!,
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD, // ⚠️ Never hardcode
  tls: process.env.NODE_ENV === "production", // TLS in prod
  username: process.env.REDIS_USER,
  database: parseInt(process.env.REDIS_DB || "0")
})

// ❌ Bad: Credentials in code
const badLayer = makeLayer({
  password: "my-secret-password" // DON'T DO THIS!
})
```

### 📝 Security History

See [GitHub Security Advisories](https://github.com/Vortex-Dimension-Digital/effect-redis-bun/security/advisories) for published advisories.

---

Thanks for helping keep `effect-bun-redis` secure for everyone. 🙏
