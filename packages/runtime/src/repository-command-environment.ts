const repositoryRedirectVariables = new Set([
  "GH_HOST",
  "GH_REPO",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
  "GIT_GLOB_PATHSPECS",
  "GIT_GRAFT_FILE",
  "GIT_ICASE_PATHSPECS",
  "GIT_INDEX_FILE",
  "GIT_LITERAL_PATHSPECS",
  "GIT_NAMESPACE",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

/** Build a child environment that cannot redirect git or gh repository scope. */
export function repositoryCommandEnvironment(
  overrides: Readonly<Record<string, string>> = {},
) {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of Object.keys(environment)) {
    if (
      repositoryRedirectVariables.has(key) ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)
    ) {
      delete environment[key];
    }
  }
  environment["GIT_LITERAL_PATHSPECS"] = "1";
  return environment;
}
