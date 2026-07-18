import { Schema } from "effect";

const generatedPathSegments = new Set([
  ".gaia",
  ".turbo",
  "coverage",
  "dist",
  "gaia-runs",
  "node_modules",
]);

/** A canonical lowercase 40-character Git SHA. */
const DeliveryGitShaBaseSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
);
export const DeliveryGitShaPublicSchema = DeliveryGitShaBaseSchema;
export const DeliveryGitShaSchema = DeliveryGitShaBaseSchema.pipe(
  Schema.brand("DeliveryGitSha")
);
export const parseDeliveryGitSha =
  Schema.decodeUnknownSync(DeliveryGitShaSchema);

/** A canonical lowercase 40-character Git object ID. */
const DeliveryGitObjectIdBaseSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{40}$/u))
);
export const DeliveryGitObjectIdPublicSchema = DeliveryGitObjectIdBaseSchema;
export const DeliveryGitObjectIdSchema = DeliveryGitObjectIdBaseSchema.pipe(
  Schema.brand("DeliveryGitObjectId")
);
export const parseDeliveryGitObjectId = Schema.decodeUnknownSync(
  DeliveryGitObjectIdSchema
);

/** A safe Git branch name carried inside delivery contracts. */
const DeliveryBranchNameBaseSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(240)),
  Schema.check(
    Schema.makeFilter(
      (branch) =>
        !branch.startsWith("/") &&
        !branch.endsWith("/") &&
        !branch.startsWith(".") &&
        !branch.includes("..") &&
        !branch.includes("@{") &&
        !branch.includes("\\") &&
        !/[\u0000-\u001f\u007f ~^:?*\[]/u.test(branch) &&
        branch
          .split("/")
          .every(
            (segment) =>
              segment.length > 0 &&
              segment !== "." &&
              segment !== ".." &&
              !segment.endsWith(".lock")
          ),
      { identifier: "DeliveryBranchName" }
    )
  )
);
export const DeliveryBranchNamePublicSchema = DeliveryBranchNameBaseSchema;
export const DeliveryBranchNameSchema = DeliveryBranchNameBaseSchema.pipe(
  Schema.brand("DeliveryBranchName")
);
export const parseDeliveryBranchName = Schema.decodeUnknownSync(
  DeliveryBranchNameSchema
);

/** An owned Gaia delivery branch name. */
const DeliveryOwnedBranchNameBaseSchema = DeliveryBranchNameBaseSchema.pipe(
  Schema.check(Schema.isPattern(/^gaia\/[A-Za-z0-9._/-]+$/u))
);
export const DeliveryOwnedBranchNamePublicSchema =
  DeliveryOwnedBranchNameBaseSchema;
export const DeliveryOwnedBranchNameSchema =
  DeliveryOwnedBranchNameBaseSchema.pipe(
    Schema.brand("DeliveryOwnedBranchName")
  );
export const parseDeliveryOwnedBranchName = Schema.decodeUnknownSync(
  DeliveryOwnedBranchNameSchema
);

/** A local Git remote name such as origin. */
const DeliveryRemoteNameBaseSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(120)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/u))
);
export const DeliveryRemoteNamePublicSchema = DeliveryRemoteNameBaseSchema;
export const DeliveryRemoteNameSchema = DeliveryRemoteNameBaseSchema.pipe(
  Schema.brand("DeliveryRemoteName")
);
export const parseDeliveryRemoteName = Schema.decodeUnknownSync(
  DeliveryRemoteNameSchema
);

/** A GitHub repository identity in owner/name form. */
const GitHubRepositoryBaseSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)),
  Schema.check(Schema.isMaxLength(200))
);
export const GitHubRepositoryPublicSchema = GitHubRepositoryBaseSchema;
export const GitHubRepositorySchema = GitHubRepositoryBaseSchema.pipe(
  Schema.brand("GitHubRepository")
);
export const parseGitHubRepository = Schema.decodeUnknownSync(
  GitHubRepositorySchema
);

/** A GitHub actor login. */
const GitHubLoginBaseSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u)
  )
);
export const GitHubLoginPublicSchema = GitHubLoginBaseSchema;
export const GitHubLoginSchema = GitHubLoginBaseSchema.pipe(
  Schema.brand("GitHubLogin")
);
export const parseGitHubLogin = Schema.decodeUnknownSync(GitHubLoginSchema);

/** A GitHub pull-request URL. */
const GitHubPullRequestUrlBaseSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/[1-9]\d*$/u
    )
  )
);
export const GitHubPullRequestUrlPublicSchema = GitHubPullRequestUrlBaseSchema;
export const GitHubPullRequestUrlSchema = GitHubPullRequestUrlBaseSchema.pipe(
  Schema.brand("GitHubPullRequestUrl")
);
export const parseGitHubPullRequestUrl = Schema.decodeUnknownSync(
  GitHubPullRequestUrlSchema
);

/** A non-empty pull-request selector accepted by GitHub delivery commands. */
const GitHubPullRequestSelectorBaseSchema = Schema.NonEmptyString;
export const GitHubPullRequestSelectorPublicSchema =
  GitHubPullRequestSelectorBaseSchema;
export const GitHubPullRequestSelectorSchema =
  GitHubPullRequestSelectorBaseSchema.pipe(
    Schema.brand("GitHubPullRequestSelector")
  );
export type GitHubPullRequestSelector =
  typeof GitHubPullRequestSelectorSchema.Type;
export const parseGitHubPullRequestSelector = Schema.decodeUnknownSync(
  GitHubPullRequestSelectorSchema
);

/** Normalized GitHub checks status recorded for a Gaia delivery. */
export const GitHubChecksStatusSchema = Schema.Literals([
  "green",
  "failing",
  "pending",
  "no-checks-configured",
  "provider-unavailable",
] as const);
export type GitHubChecksStatus = typeof GitHubChecksStatusSchema.Type;

/** GitHub PR human-feedback status recorded for a Gaia delivery. */
export const GitHubPrFeedbackStatusSchema = Schema.Literals([
  "awaiting-review",
  "changes-requested",
  "clear",
  "comments",
] as const);
export type GitHubPrFeedbackStatus = typeof GitHubPrFeedbackStatusSchema.Type;

/** A GitHub-hosted provider URL for privacy-safe public evidence. */
const GitHubProviderUrlBaseSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^https:\/\/github\.com\/[^\s]+$/u)),
  Schema.check(Schema.isMaxLength(2_048))
);
export const GitHubProviderUrlPublicSchema = GitHubProviderUrlBaseSchema;
export const GitHubProviderUrlSchema = GitHubProviderUrlBaseSchema.pipe(
  Schema.brand("GitHubProviderUrl")
);
export const parseGitHubProviderUrl = Schema.decodeUnknownSync(
  GitHubProviderUrlSchema
);

/** A stable delivery operation ID. */
const DeliveryOperationIdBaseSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9:_-]+$/u)),
  Schema.check(Schema.isMaxLength(200))
);
export const DeliveryOperationIdPublicSchema = DeliveryOperationIdBaseSchema;
export const DeliveryOperationIdSchema = DeliveryOperationIdBaseSchema.pipe(
  Schema.brand("DeliveryOperationId")
);
export const parseDeliveryOperationId = Schema.decodeUnknownSync(
  DeliveryOperationIdSchema
);

/** A stable delivery action or idempotency ID. */
const DeliveryActionIdBaseSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9:_-]+$/u)),
  Schema.check(Schema.isMaxLength(200))
);
export const DeliveryActionIdPublicSchema = DeliveryActionIdBaseSchema;
export const DeliveryActionIdSchema = DeliveryActionIdBaseSchema.pipe(
  Schema.brand("DeliveryActionId")
);
export const parseDeliveryActionId = Schema.decodeUnknownSync(
  DeliveryActionIdSchema
);

/** A lowercase SHA-256 digest. */
const DeliverySha256DigestBaseSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
);
export const DeliverySha256DigestPublicSchema = DeliverySha256DigestBaseSchema;
export const DeliverySha256DigestSchema = DeliverySha256DigestBaseSchema.pipe(
  Schema.brand("DeliverySha256Digest")
);
export const parseDeliverySha256Digest = Schema.decodeUnknownSync(
  DeliverySha256DigestSchema
);

/** A persisted UTC ISO timestamp with millisecond precision. */
const DeliveryTimestampBaseSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  )
);
export const DeliveryTimestampPublicSchema = DeliveryTimestampBaseSchema;
export const DeliveryTimestampSchema = DeliveryTimestampBaseSchema.pipe(
  Schema.brand("DeliveryTimestamp")
);
export const parseDeliveryTimestamp = Schema.decodeUnknownSync(
  DeliveryTimestampSchema
);

/** A stable Gaia delivery evidence identifier. */
const DeliveryEvidenceIdBaseSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^evidence-[A-Za-z0-9_-]{16,120}$/u)),
  Schema.check(Schema.isMaxLength(129))
);
export const DeliveryEvidenceIdPublicSchema = DeliveryEvidenceIdBaseSchema;
export const DeliveryEvidenceIdSchema = DeliveryEvidenceIdBaseSchema.pipe(
  Schema.brand("DeliveryEvidenceId")
);
export const parseDeliveryEvidenceId = Schema.decodeUnknownSync(
  DeliveryEvidenceIdSchema
);

/** A stable GitHub check field such as app slug, workflow, or check name. */
const GitHubCheckFieldBaseSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_.:/ -]+$/u)),
  Schema.check(Schema.isMaxLength(200))
);
export const GitHubCheckFieldPublicSchema = GitHubCheckFieldBaseSchema;
export const GitHubCheckFieldSchema = GitHubCheckFieldBaseSchema.pipe(
  Schema.brand("GitHubCheckField")
);
export const parseGitHubCheckField = Schema.decodeUnknownSync(
  GitHubCheckFieldSchema
);

/** A bounded public provider database ID. */
const GitHubDatabaseIdBaseSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[1-9]\d*$/u)),
  Schema.check(Schema.isMaxLength(30))
);
export const GitHubDatabaseIdPublicSchema = GitHubDatabaseIdBaseSchema;
export const GitHubDatabaseIdSchema = GitHubDatabaseIdBaseSchema.pipe(
  Schema.brand("GitHubDatabaseId")
);
export const parseGitHubDatabaseId = Schema.decodeUnknownSync(
  GitHubDatabaseIdSchema
);

/** A safe source path included in delivery publication receipts. */
const DeliverySourcePathBaseSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(1_024)),
  Schema.check(
    Schema.makeFilter(
      (path) =>
        !path.startsWith("/") &&
        !path.includes("\\") &&
        !/[\u0000-\u001f\u007f]/u.test(path) &&
        path
          .split("/")
          .every(
            (segment) =>
              segment.length > 0 &&
              segment !== "." &&
              segment !== ".." &&
              !generatedPathSegments.has(segment)
          ),
      { identifier: "DeliverySourcePath" }
    )
  )
);
export const DeliverySourcePathPublicSchema = DeliverySourcePathBaseSchema;
export const DeliverySourcePathSchema = DeliverySourcePathBaseSchema.pipe(
  Schema.brand("DeliverySourcePath")
);
export const parseDeliverySourcePath = Schema.decodeUnknownSync(
  DeliverySourcePathSchema
);

/** A one-line commit message persisted in publication receipts. */
const DeliveryCommitMessageBaseSchema = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(240)),
  Schema.check(Schema.isPattern(/^[^\r\n]+$/u))
);
export const DeliveryCommitMessagePublicSchema =
  DeliveryCommitMessageBaseSchema;
export const DeliveryCommitMessageSchema = DeliveryCommitMessageBaseSchema.pipe(
  Schema.brand("DeliveryCommitMessage")
);
export const parseDeliveryCommitMessage = Schema.decodeUnknownSync(
  DeliveryCommitMessageSchema
);

/** A positive delivery sequence or number. */
export const DeliveryPositiveIntegerSchema = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1))
);

export class GitHubCheckIdentity extends Schema.Class<GitHubCheckIdentity>(
  "GitHubCheckIdentity"
)(
  {
    appSlug: GitHubCheckFieldSchema,
    name: GitHubCheckFieldSchema,
    repository: GitHubRepositorySchema,
    workflow: GitHubCheckFieldSchema,
  },
  { parseOptions: { onExcessProperty: "error" } }
) {}
