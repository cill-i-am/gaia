# Profiles Intent

`profiles/*` contains run profile fixtures that choose Gaia check policy for a
run. Profiles are policy inputs, not code.

## Profile Rules

- Keep profile JSON explicit and small. Do not hide behavior behind implicit
  defaults when the profile can state the policy.
- `@gaia/runtime` owns profile parsing and enforcement. Update parser tests when
  adding profile fields.
- Browser evidence policy must be intentional: `optional` means useful evidence,
  `required` means failed capture blocks completion.
- Profiles should not contain secrets, personal paths, or machine-specific
  credentials.
