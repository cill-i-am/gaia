---
title: Claim-matched verification V2
verification:
  version: 2
  outcomes:
    - key: smoke-output
      statement: The smoke command exits 0 and emits exactly gaia-claim-ok.
      sourceItemDigest: 3dfad97fa384fc8d25327a9bd7d7a4d94ea2ce584721f9265f57047f73b01ee4
      prePublicationRequiredClaims: [smoke-command]
      postPublicationRequiredClaims: [smoke-ci, smoke-review]
      conditionalClaims: []
  claims:
    - key: smoke-command
      statement: Run the pinned POSIX printf command with no network or credentials.
      sourceItemDigest: 18779fd56a0ba44e8a12233232d1bed9ba6b10810daf7ad104b81cd81d392e81
      phase: prePublication
      kind: command
      command:
        executableId: posix-printf-v1
        argv: ["%s", "gaia-claim-ok\n"]
        workingDirectory: .
        timeoutMs: 30000
        outputLimitBytes: 1048576
        workspaceAccess: read-write
        network: denied
        credentials: none
        expectedExitCode: 0
        expectedStdoutByteLength: 14
        expectedStdoutSha256: c67d2c0ac3e5ea53ed76dadc9aab773e884efedcaac2be11aaa4b096576f5849
    - key: smoke-ci
      statement: GitHub check test on workflow ci is successful for the published exact head.
      sourceItemDigest: eb8dad3ee6715b9bf4c42489fd0796fae288f99e9111f6e4d417e3d6c012e45e
      phase: postPublication
      kind: external-check
      selector:
        provider: github
        workflow: ci
        checkName: test
        conclusion: success
    - key: smoke-review
      statement: Paired local reviewer approved the published exact head.
      sourceItemDigest: ed8194e9c24785c3d543f038ff65df435885004ceb93e84f1401b43dd8aad492
      phase: postPublication
      kind: human-judgment
      selector:
        source: localOperatorPairedReview
        decision: approved
---

## Acceptance Criteria

- The smoke command exits 0 and emits exactly gaia-claim-ok.

## Verification

- Run the pinned POSIX printf command with no network or credentials.
- GitHub check test on workflow ci is successful for the published exact head.
- Paired local reviewer approved the published exact head.
