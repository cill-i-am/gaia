const schemaFirstMessage =
  "Serializable data contracts must originate in Effect Schema. Remedy: define the owning Schema and derive its Type.";
const unbrandedDomainStringMessage =
  "Semantic field '{{name}}' must use a branded schema-derived value. Remedy: parse with the owning Schema and carry the branded value inward.";

const terminalSemanticTokens = new Set([
  "branch",
  "branches",
  "command",
  "commands",
  "digest",
  "digests",
  "directories",
  "directory",
  "handle",
  "handles",
  "hash",
  "hashes",
  "id",
  "identifier",
  "identifiers",
  "ids",
  "model",
  "models",
  "oid",
  "oids",
  "path",
  "paths",
  "ref",
  "refs",
  "remote",
  "remotes",
  "repo",
  "repos",
  "repositories",
  "repository",
  "sha",
  "shas",
  "timestamp",
  "timestamps",
  "uri",
  "uris",
  "url",
  "urls",
  "version",
  "versions",
]);
const lifecycleTimePrefixes = new Set([
  "canceled",
  "completed",
  "created",
  "expired",
  "expires",
  "merged",
  "published",
  "received",
  "recorded",
  "started",
  "updated",
]);
const semanticDomainNames = new Set([
  "branchName",
  "harnessName",
  "providerName",
  "remoteName",
  "repositoryName",
  "reviewerName",
  "skillName",
]);
const displayAndProseNames = new Set([
  "content",
  "description",
  "displayName",
  "label",
  "labels",
  "message",
  "reason",
  "remediation",
  "summary",
  "text",
  "title",
  "tooltip",
]);
const frameworkStateNames = new Set([
  "asChild",
  "className",
  "collapsible",
  "defaultOpen",
  "disabled",
  "inset",
  "isActive",
  "isMobile",
  "open",
  "openMobile",
  "pending",
  "showCloseButton",
  "showIcon",
  "showOnHover",
  "side",
  "size",
  "state",
  "style",
  "variant",
  "withHandle",
]);
const providerProjectionNames = new Set([
  "CommandApprovalRequest",
  "ElicitationRequest",
  "FileApprovalRequest",
  "PermissionApprovalRequest",
  "UserInputRequest",
]);
const providerParityMetadataNames = new Set([
  "completedAt",
  "createdAt",
  "startedAt",
  "updatedAt",
]);
const providerBoundarySchemaFields = new Map(
  Object.entries({
    CodexAppServerIncompatibilityError: ["actualUserAgent", "supportedVersion"],
    CodexFileChange: ["path"],
    CodexListedThreadSchema: ["sessionId"],
    CodexRawBaseInteraction: ["itemId", "threadId", "turnId"],
    CodexRawCommandActionSchema: ["command", "path", "type"],
    CodexRawElicitationRequest: ["elicitationId", "threadId", "url"],
    CodexRawFileChangeSchema: ["path"],
    CodexRawFileSystemPathSchema: ["path", "type"],
    CodexRawFileSystemSpecialPathSchema: ["path"],
    CodexRawMemoryCitationEntrySchema: ["path"],
    CodexRawModelSchema: ["id", "model"],
    CodexRawNotificationSchema: ["itemId", "threadId", "turn", "turnId"],
    CodexRawThreadItemSchema: [
      "command",
      "hookRunId",
      "id",
      "imageUrl",
      "path",
      "senderThreadId",
      "text",
    ],
    CodexRawThreadRuntimeResultFields: ["id", "model"],
    CodexRawThreadSchema: ["cliVersion", "id", "sessionId"],
    CodexRawThreadSpawnSourceSchema: ["parent_thread_id"],
    CodexRawTurnSchema: ["id"],
    CodexRawUserInputRequest: ["id"],
    CodexRawUserInputSchema: ["path", "url"],
    CodexThreadItemSchema: ["command"],
    ElicitationRequest: ["elicitationId"],
    FileSystemPathSchema: ["path"],
    TurnSteerBoundaryResultSchema: ["turnId"],
    UserInputQuestion: ["id"],
  }).map(([declarationName, fieldNames]) => [
    declarationName,
    new Set(fieldNames),
  ])
);
const rawParameterNames = new Set(["input", "raw", "value"]);
const callableNodeTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSFunctionType",
  "TSMethodSignature",
]);
const transparentCallableWrappers = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSParenthesizedType",
  "TSSatisfiesExpression",
  "TSTypeAnnotation",
  "TSTypeAssertion",
]);

const getStaticName = (node) => {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return undefined;
};

const hasRepoRelativePath = (filename, expectedPath) => {
  const normalized = filename.replaceAll("\\", "/");
  return normalized === expectedPath || normalized.endsWith(`/${expectedPath}`);
};

const isCodexProviderProtocolFile = (filename) =>
  hasRepoRelativePath(
    filename,
    "packages/runtime/src/codex-app-server-protocol.ts"
  );

const isCodexProviderParityFile = (filename) =>
  hasRepoRelativePath(
    filename,
    "packages/runtime/src/codex-app-server-0.137.0-schema-parity.test.ts"
  );

const isDeliveryMergeConfirmationFile = (filename) =>
  hasRepoRelativePath(
    filename,
    "apps/dashboard/src/components/delivery-merge-confirmation.tsx"
  );

const isDashboardRouterFile = (filename) =>
  hasRepoRelativePath(filename, "apps/dashboard/src/router.tsx");

const tokenizeName = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((token) => token.toLowerCase());

const isSemanticName = (name) => {
  if (semanticDomainNames.has(name)) return true;

  const tokens = tokenizeName(name);
  const terminal = tokens.at(-1);
  if (terminal === undefined) return false;
  if (terminalSemanticTokens.has(terminal)) return true;

  return (
    terminal === "at" &&
    tokens.length >= 2 &&
    lifecycleTimePrefixes.has(tokens.at(-2))
  );
};

const isStringTypeAnnotation = (node) =>
  node?.typeAnnotation?.typeAnnotation.type === "TSStringKeyword";

const findEnclosingFunction = (node) => {
  let current = node.parent;
  while (current !== undefined && current !== null) {
    if (callableNodeTypes.has(current.type)) return current;
    current = current.parent;
  }
  return undefined;
};

const findDirectEnclosingFunction = (node) => {
  const callable = findEnclosingFunction(node);
  if (callable === undefined) return undefined;

  const isWithinParameter = callable.params?.some((parameter) => {
    let current = node;
    while (current !== undefined && current !== null && current !== callable) {
      if (current === parameter) return true;
      current = current.parent;
    }
    return false;
  });
  return isWithinParameter === true ? callable : undefined;
};

const getDirectCallableOwnerName = (node) => {
  let current = node.parent;
  while (current !== undefined && current !== null) {
    if (transparentCallableWrappers.has(current.type)) {
      current = current.parent;
      continue;
    }
    if (current.type === "VariableDeclarator") {
      return getStaticName(current.id);
    }
    if (
      current.type === "MethodDefinition" ||
      current.type === "Property" ||
      current.type === "PropertyDefinition" ||
      current.type === "TSAbstractMethodDefinition" ||
      current.type === "TSAbstractPropertyDefinition" ||
      current.type === "TSPropertySignature"
    ) {
      return getStaticName(current.key);
    }
    if (
      current.type === "TSInterfaceBody" ||
      current.type === "TSTypeLiteral"
    ) {
      current = current.parent;
      continue;
    }
    if (
      current.type === "TSInterfaceDeclaration" ||
      current.type === "TSTypeAliasDeclaration"
    ) {
      return getStaticName(current.id);
    }
    return undefined;
  }
  return undefined;
};

const getFunctionName = (node) => {
  if (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression"
  ) {
    return getStaticName(node.id) ?? getDirectCallableOwnerName(node);
  }
  if (node?.type === "TSMethodSignature") return getStaticName(node.key);
  if (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "TSCallSignatureDeclaration" ||
    node?.type === "TSConstructSignatureDeclaration" ||
    node?.type === "TSFunctionType"
  ) {
    return getDirectCallableOwnerName(node);
  }
  return undefined;
};

const isRawParserParameter = (node, name) => {
  if (!rawParameterNames.has(name)) return false;
  const functionName = getFunctionName(findDirectEnclosingFunction(node));
  return (
    functionName !== undefined && /^(?:decode|parse)[A-Z]/u.test(functionName)
  );
};

const isProviderRawParameter = (context, node, name) => {
  if (!isCodexProviderProtocolFile(context.filename)) return false;
  if (name !== "identifier") return false;
  return (
    getFunctionName(findDirectEnclosingFunction(node)) === "strictRawStruct"
  );
};

const getParameterSemanticName = (node, name) => {
  if (!rawParameterNames.has(name)) return name;
  return getFunctionName(findDirectEnclosingFunction(node)) ?? name;
};

const isRawCallableParameter = (node, name) =>
  rawParameterNames.has(name) &&
  findDirectEnclosingFunction(node) !== undefined;

const isDirectUnbrandedSchemaString = (node) =>
  node?.type === "MemberExpression" &&
  !node.computed &&
  node.object.type === "Identifier" &&
  node.object.name === "Schema" &&
  node.property.type === "Identifier" &&
  (node.property.name === "String" || node.property.name === "NonEmptyString");

const isSchemaTypeQueryCandidate = (node) =>
  node?.type === "TSTypeQuery" &&
  node.exprName.type === "TSQualifiedName" &&
  node.exprName.right.type === "Identifier" &&
  node.exprName.right.name === "Type";

const isFunctionTypeMember = (member) => {
  if (
    member.type === "TSCallSignatureDeclaration" ||
    member.type === "TSConstructSignatureDeclaration" ||
    member.type === "TSMethodSignature"
  ) {
    return true;
  }

  return (
    member.type === "TSPropertySignature" &&
    member.typeAnnotation?.typeAnnotation.type === "TSFunctionType"
  );
};

const isAllCallable = (members) =>
  members.length > 0 && members.every(isFunctionTypeMember);

const getTypeParameters = (node) =>
  node?.typeParameters?.params ?? node?.typeArguments?.params ?? [];

const getEnclosingTypeReference = (node) => {
  if (node.parent?.type === "TSTypeReference") return node.parent;
  if (
    node.parent?.type === "TSTypeParameterInstantiation" &&
    node.parent.parent?.type === "TSTypeReference"
  ) {
    return node.parent.parent;
  }
  return undefined;
};

const getTypeReferenceName = (node) => {
  if (node?.type !== "TSTypeReference") return undefined;
  const name = node.typeName;
  if (name?.type === "Identifier") return name.name;
  if (name?.type === "TSQualifiedName") {
    const left = getTypeReferenceName({
      type: "TSTypeReference",
      typeName: name.left,
    });
    return left === undefined ? name.right.name : `${left}.${name.right.name}`;
  }
  return undefined;
};

const isFrameworkTypeReference = (node, options = {}) => {
  const name = getTypeReferenceName(node);
  if (name === "Readonly") {
    if (options.allowReadonly !== true) return false;
    const parameters = getTypeParameters(node);
    return (
      parameters.length === 1 &&
      parameters[0].type === "TSTypeLiteral" &&
      parameters[0].members.length > 0 &&
      parameters[0].members.every((member) =>
        isFrameworkMember({ filename: "" }, undefined, member)
      )
    );
  }
  return (
    name !== undefined &&
    (name === "ReactNode" ||
      (name.includes(".") && name.split(".").at(-1)?.endsWith("Props")) ||
      name.endsWith("ComponentProps") ||
      name.endsWith("ComponentPropsWithRef") ||
      name.endsWith("ComponentPropsWithoutRef") ||
      name === "VariantProps")
  );
};

const isLiteralFrameworkStateType = (node) => {
  if (node?.type === "TSBooleanKeyword" || node?.type === "TSNumberKeyword") {
    return true;
  }
  if (node?.type === "TSLiteralType") return true;
  return (
    node?.type === "TSUnionType" &&
    node.types.length > 0 &&
    node.types.every(isLiteralFrameworkStateType)
  );
};

const isFrameworkDisplayType = (node) => {
  if (node?.type === "TSStringKeyword") return true;
  if (isFrameworkTypeReference(node)) return true;
  return (
    node?.type === "TSUnionType" &&
    node.types.length > 0 &&
    node.types.every(
      (candidate) =>
        candidate.type === "TSStringKeyword" ||
        isFrameworkTypeReference(candidate)
    )
  );
};

const isTanStackRouterRegisterAugmentation = (declaration) => {
  const moduleBlock = declaration?.parent;
  const moduleDeclaration = moduleBlock?.parent;
  return (
    moduleBlock?.type === "TSModuleBlock" &&
    moduleDeclaration?.type === "TSModuleDeclaration" &&
    moduleDeclaration.id?.type === "Literal" &&
    moduleDeclaration.id.value === "@tanstack/react-router"
  );
};

const isReturnTypeOfGetRouter = (typeNode) => {
  const parameters = getTypeParameters(typeNode);
  return (
    getTypeReferenceName(typeNode) === "ReturnType" &&
    parameters.length === 1 &&
    parameters[0]?.type === "TSTypeQuery" &&
    parameters[0].exprName.type === "Identifier" &&
    parameters[0].exprName.name === "getRouter"
  );
};

const isFrameworkReturnTypeMember = (context, declaration, member, typeNode) =>
  isDashboardRouterFile(context.filename) &&
  declaration?.id?.type === "Identifier" &&
  declaration.id.name === "Register" &&
  isTanStackRouterRegisterAugmentation(declaration) &&
  getStaticName(member.key) === "router" &&
  isReturnTypeOfGetRouter(typeNode);

function isFrameworkMember(context, declaration, member) {
  if (isFunctionTypeMember(member)) return true;
  if (member.type !== "TSPropertySignature") return false;

  const name = getStaticName(member.key);
  const typeNode = member.typeAnnotation?.typeAnnotation;
  if (
    isFrameworkTypeReference(typeNode, { allowReadonly: true }) ||
    isFrameworkReturnTypeMember(context, declaration, member, typeNode)
  ) {
    return true;
  }
  return (
    name !== undefined &&
    ((displayAndProseNames.has(name) && isFrameworkDisplayType(typeNode)) ||
      (frameworkStateNames.has(name) && isLiteralFrameworkStateType(typeNode)))
  );
}

const isFrameworkDeclarationName = (name) =>
  name.endsWith("Props") || name === "Register";

const isFrameworkProps = (context, node, members) =>
  context.filename.endsWith(".tsx") &&
  node.id?.type === "Identifier" &&
  isFrameworkDeclarationName(node.id.name) &&
  members.length > 0 &&
  members.every((member) => isFrameworkMember(context, node, member));

const hasFrameworkIntersectionContext = (node) =>
  node.parent?.type === "TSIntersectionType" &&
  node.parent.types.some(
    (candidate) => candidate !== node && isFrameworkTypeReference(candidate)
  );

const hasFrameworkGenericContext = (node) =>
  getTypeReferenceName(getEnclosingTypeReference(node)) === "Readonly" &&
  getTypeParameters(getEnclosingTypeReference(node)).length === 1 &&
  getTypeParameters(getEnclosingTypeReference(node))[0] === node;

const findEnclosingTypeAlias = (node) => {
  let current = node.parent;
  while (current !== undefined && current !== null) {
    if (current.type === "TSTypeAliasDeclaration") return current;
    if (
      current.type === "Program" ||
      current.type === "TSInterfaceDeclaration"
    ) {
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
};

const hasDeliveryMergeConfirmationDataContext = (context, node) =>
  isDeliveryMergeConfirmationFile(context.filename) &&
  findEnclosingTypeAlias(node)?.id?.type === "Identifier" &&
  findEnclosingTypeAlias(node).id.name === "DeliveryMergeConfirmationData" &&
  node.members.every(
    (member) =>
      member.type === "TSPropertySignature" &&
      (member.typeAnnotation?.typeAnnotation.type === "TSIndexedAccessType" ||
        (member.typeAnnotation?.typeAnnotation.type === "TSTypeReference" &&
          getTypeReferenceName(member.typeAnnotation.typeAnnotation) ===
            "DeliveryMergeDecisionSequence"))
  );

const hasDeliveryMergeConfirmationPropsContext = (context, node) =>
  isDeliveryMergeConfirmationFile(context.filename) &&
  node.parent?.type === "TSIntersectionType" &&
  findEnclosingTypeAlias(node)?.id?.type === "Identifier" &&
  findEnclosingTypeAlias(node).id.name === "DeliveryMergeConfirmationProps" &&
  node.parent.types.some(
    (candidate) =>
      candidate.type === "TSTypeReference" &&
      getTypeReferenceName(candidate) === "DeliveryMergeConfirmationData"
  );

const isFrameworkTypeLiteral = (context, node, members) =>
  context.filename.endsWith(".tsx") &&
  members.length > 0 &&
  ((members.every((member) => isFrameworkMember(context, undefined, member)) &&
    (hasFrameworkIntersectionContext(node) ||
      hasFrameworkGenericContext(node) ||
      hasDeliveryMergeConfirmationPropsContext(context, node))) ||
    hasDeliveryMergeConfirmationDataContext(context, node));

const getEnclosingDeclarationNames = (node) => {
  const names = [];
  let current = node.parent;
  while (current !== undefined && current !== null) {
    if (current.type === "VariableDeclarator") {
      const name = getStaticName(current.id);
      if (name !== undefined) names.push(name);
    } else if (
      current.type === "ClassDeclaration" ||
      current.type === "FunctionDeclaration" ||
      current.type === "TSInterfaceDeclaration" ||
      current.type === "TSTypeAliasDeclaration"
    ) {
      const name = getStaticName(current.id);
      if (name !== undefined) names.push(name);
    }
    current = current.parent;
  }
  return names;
};

const isProviderSchemaMetadata = (context, node, name) =>
  isCodexProviderParityFile(context.filename) &&
  providerParityMetadataNames.has(name) &&
  getEnclosingDeclarationNames(node).includes("PinnedCodexSchemaSet");

const isProviderBoundarySchemaProperty = (context, node, name) =>
  isProviderSchemaMetadata(context, node, name) ||
  (isCodexProviderProtocolFile(context.filename) &&
    getEnclosingDeclarationNames(node).some((declarationName) =>
      providerBoundarySchemaFields.get(declarationName)?.has(name)
    ));

const isProviderProjectionSelector = (context, node) => {
  if (!isCodexProviderProtocolFile(context.filename)) return false;
  const parent = getEnclosingTypeReference(node);
  if (parent?.type !== "TSTypeReference") return false;
  const typeName = getTypeReferenceName(parent);
  if (typeName !== "Extract") return false;
  const parameters = getTypeParameters(parent);
  if (parameters.length < 2 || parameters[0] === node) return false;
  const alias = parent.parent;
  return (
    alias?.type === "TSTypeAliasDeclaration" &&
    alias.id?.type === "Identifier" &&
    providerProjectionNames.has(alias.id.name)
  );
};

const patternBindsName = (pattern, name) => {
  if (pattern?.type === "Identifier") return pattern.name === name;
  if (pattern?.type === "AssignmentPattern") {
    return patternBindsName(pattern.left, name);
  }
  if (pattern?.type === "RestElement") {
    return patternBindsName(pattern.argument, name);
  }
  if (pattern?.type === "ArrayPattern") {
    return pattern.elements.some((element) => patternBindsName(element, name));
  }
  if (pattern?.type === "ObjectPattern") {
    return pattern.properties.some((property) =>
      patternBindsName(
        property.type === "RestElement" ? property.argument : property.value,
        name
      )
    );
  }
  return false;
};

const statementBindsName = (statement, name) => {
  if (statement?.type === "VariableDeclaration") {
    return statement.declarations.some((declaration) =>
      patternBindsName(declaration.id, name)
    );
  }
  return (
    (statement?.type === "ClassDeclaration" ||
      statement?.type === "FunctionDeclaration") &&
    statement.id?.name === name
  );
};

const hasShadowingBinding = (call, name) => {
  let current = call.parent;
  while (current !== undefined && current !== null) {
    if (
      (current.type === "ArrowFunctionExpression" ||
        current.type === "FunctionDeclaration" ||
        current.type === "FunctionExpression") &&
      current.params.some((parameter) => patternBindsName(parameter, name))
    ) {
      return true;
    }
    if (
      (current.type === "BlockStatement" || current.type === "Program") &&
      current.body.some((statement) => statementBindsName(statement, name))
    ) {
      return true;
    }
    if (
      current.type === "CatchClause" &&
      patternBindsName(current.param, name)
    ) {
      return true;
    }
    if (
      current.type === "ForStatement" &&
      statementBindsName(current.init, name)
    ) {
      return true;
    }
    if (
      (current.type === "ForInStatement" ||
        current.type === "ForOfStatement") &&
      statementBindsName(current.left, name)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

const isXStateSetupMetadataReference = (typeReference, setupBindings) => {
  const typeArguments = typeReference.parent;
  const call = typeArguments?.parent;
  if (
    typeArguments?.type !== "TSTypeParameterInstantiation" ||
    call?.type !== "CallExpression" ||
    call.callee.type !== "Identifier" ||
    !setupBindings.has(call.callee.name) ||
    hasShadowingBinding(call, call.callee.name)
  ) {
    return false;
  }
  const position = getTypeParameters(call).indexOf(typeReference);
  return position === 4 || position === 5;
};

const hasExactUndefinedMetadataShape = (node) =>
  node.typeAnnotation.type === "TSTypeLiteral" &&
  node.typeAnnotation.members.length > 0 &&
  node.typeAnnotation.members.every(
    (member) =>
      member.type === "TSPropertySignature" &&
      member.readonly === true &&
      member.optional !== true &&
      getStaticName(member.key) !== undefined &&
      member.typeAnnotation?.typeAnnotation.type === "TSUndefinedKeyword"
  );

const isPrivateExactUndefinedMetadataAlias = (node) =>
  node.parent?.type !== "ExportNamedDeclaration" &&
  node.parent?.type !== "ExportDefaultDeclaration" &&
  getTypeParameters(node).length === 0 &&
  hasExactUndefinedMetadataShape(node);

const schemaFirstDataContract = {
  meta: {
    messages: {
      schemaFirst: schemaFirstMessage,
    },
    type: "problem",
  },
  create(context) {
    const setupBindings = new Set();
    const typeAliases = [];
    const typeReferences = [];
    const reportDeclaration = (node, members) => {
      if (
        !isAllCallable(members) &&
        !isFrameworkProps(context, node, members)
      ) {
        context.report({ messageId: "schemaFirst", node: node.id ?? node });
      }
    };

    return {
      ImportDeclaration(node) {
        if (node.source.value !== "xstate" || node.importKind === "type")
          return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.importKind !== "type" &&
            getStaticName(specifier.imported) === "setup" &&
            specifier.local.type === "Identifier"
          ) {
            setupBindings.add(specifier.local.name);
          }
        }
      },
      "Program:exit"() {
        for (const node of typeAliases) {
          const name = getStaticName(node.id);
          const references =
            name === undefined
              ? []
              : typeReferences.filter(
                  (reference) => getTypeReferenceName(reference) === name
                );
          const metadataReferences = references.filter((reference) =>
            isXStateSetupMetadataReference(reference, setupBindings)
          );
          const confinedToMetadataPositions =
            references.length > 0 &&
            metadataReferences.length === references.length;
          const exactMetadataAlias =
            confinedToMetadataPositions &&
            references.every(
              (reference) => getTypeParameters(reference).length === 0
            ) &&
            isPrivateExactUndefinedMetadataAlias(node);
          const invalidMetadataAlias =
            metadataReferences.length > 0 && !exactMetadataAlias;
          if (node.typeAnnotation.type === "TSTypeLiteral") {
            if (
              invalidMetadataAlias ||
              (!exactMetadataAlias &&
                !isAllCallable(node.typeAnnotation.members) &&
                !isFrameworkProps(context, node, node.typeAnnotation.members))
            ) {
              context.report({ messageId: "schemaFirst", node: node.id });
            }
          } else if (invalidMetadataAlias) {
            context.report({ messageId: "schemaFirst", node: node.id });
          }
        }
      },
      TSInterfaceDeclaration(node) {
        reportDeclaration(node, node.body.body);
      },
      TSTypeAliasDeclaration(node) {
        if (
          node.typeAnnotation.type !== "TSTypeLiteral" ||
          isAllCallable(node.typeAnnotation.members) ||
          hasExactUndefinedMetadataShape(node)
        ) {
          typeAliases.push(node);
          return;
        }
        reportDeclaration(node, node.typeAnnotation.members);
      },
      TSTypeReference(node) {
        typeReferences.push(node);
      },
      TSTypeLiteral(node) {
        if (node.parent?.type === "TSTypeAliasDeclaration") return;
        if (
          isFrameworkTypeLiteral(context, node, node.members) ||
          isProviderProjectionSelector(context, node)
        ) {
          return;
        }
        if (!isAllCallable(node.members)) {
          context.report({ messageId: "schemaFirst", node });
        }
      },
    };
  },
};

const noUnbrandedDomainString = {
  meta: {
    messages: {
      unbrandedDomainString: unbrandedDomainStringMessage,
    },
    type: "problem",
  },
  create(context) {
    const report = (node, name) => {
      context.report({
        data: { name },
        messageId: "unbrandedDomainString",
        node,
      });
    };

    return {
      Identifier(node) {
        if (
          !isStringTypeAnnotation(node) ||
          findDirectEnclosingFunction(node) === undefined
        ) {
          return;
        }
        const semanticName = getParameterSemanticName(node, node.name);
        if (
          !isRawParserParameter(node, node.name) &&
          !isProviderRawParameter(context, node, node.name) &&
          (isSemanticName(semanticName) ||
            isRawCallableParameter(node, node.name))
        ) {
          report(node, semanticName);
        }
      },
      Property(node) {
        const name = getStaticName(node.key);
        if (
          name !== undefined &&
          isSemanticName(name) &&
          isDirectUnbrandedSchemaString(node.value) &&
          !isProviderBoundarySchemaProperty(context, node, name)
        ) {
          report(node.key, name);
        }
      },
      TSPropertySignature(node) {
        const name = getStaticName(node.key);
        if (
          name !== undefined &&
          isSemanticName(name) &&
          isStringTypeAnnotation(node) &&
          !isProviderBoundarySchemaProperty(context, node, name)
        ) {
          report(node.key, name);
        }
      },
    };
  },
};

const noBrandCast = {
  meta: {
    messages: {
      brandCastCandidate:
        "Assertion targets a schema output candidate. Remedy: decode with the owning Schema instead of asserting a branded value; the compiler checker proves brand provenance.",
    },
    type: "problem",
  },
  create(context) {
    const checkAssertion = (node) => {
      if (isSchemaTypeQueryCandidate(node.typeAnnotation)) {
        context.report({ messageId: "brandCastCandidate", node });
      }
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
};

const plugin = {
  meta: {
    name: "gaia",
  },
  rules: {
    "no-brand-cast": noBrandCast,
    "no-unbranded-domain-string": noUnbrandedDomainString,
    "schema-first-data-contract": schemaFirstDataContract,
  },
};

export default plugin;
