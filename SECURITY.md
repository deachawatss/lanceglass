# Security and privacy

Lanceglass processes files that may contain source code, prompts, tool output,
paths, and other sensitive material. Treat every real JSONL file and generated
LanceDB directory as private.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not include
real session content, credentials, account identifiers, or private paths in a
public issue.

## Before publishing a fork

Verify the complete commit history, not only the working tree:

```bash
git grep -n -I -E '(/Users/|/home/|/opt/|BEGIN .*PRIVATE KEY|Bearer [A-Za-z0-9])' $(git rev-list --all)
git ls-files | grep -E '(^|/)(\.data|node_modules|ui/dist|maw-plugin/dist)/' && exit 1 || true
```

Also run a dedicated secret scanner such as Gitleaks when available. Placeholder
tokens in tests must be obviously synthetic and must assert that secrets are
redacted from errors and output.

## Runtime boundary

- The HTTP server binds to loopback by default.
- Mutating HTTP requests validate local host/origin and use bounded bodies.
- Remote embedding providers are opt-in and credentials stay in environment
  variables.
- Import never sends text to an embedding endpoint.

This is local developer software, not a hardened multi-user hosted service.
