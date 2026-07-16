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
const providerBoundarySchemaNames = new Set([
  "CodexAppServerIncompatibilityError",
  "CodexFileChange",
  "CodexListedThreadSchema",
  "CodexRawBaseInteraction",
  "CodexRawCommandActionSchema",
  "CodexRawElicitationRequest",
  "CodexRawFileChangeSchema",
  "CodexRawFileSystemPathSchema",
  "CodexRawFileSystemSpecialPathSchema",
  "CodexRawMemoryCitationEntrySchema",
  "CodexRawModelSchema",
  "CodexRawNotificationSchema",
  "CodexRawThreadItemSchema",
  "CodexRawThreadRuntimeResultFields",
  "CodexRawThreadSchema",
  "CodexRawThreadSpawnSourceSchema",
  "CodexRawTurnSchema",
  "CodexRawUserInputRequest",
  "CodexRawUserInputSchema",
  "CodexThreadItemSchema",
  "ElicitationRequest",
  "FileSystemPathSchema",
  "TurnSteerBoundaryResultSchema",
  "UserInputQuestion",
]);
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

const isCodexProviderProtocolFile = (filename) =>
  /(?:^|[/\\])codex-app-server-protocol\.ts$/u.test(filename);

const isCodexProviderParityFile = (filename) =>
  /(?:^|[/\\])codex-app-server-0\.137\.0-schema-parity\.test\.ts$/u.test(
    filename
  );

const isDeliveryMergeConfirmationFile = (filename) =>
  /(?:^|[/\\])delivery-merge-confirmation\.tsx$/u.test(filename);

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
        isFrameworkMember(undefined, member)
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

const isFrameworkReturnTypeMember = (declaration, member, typeNode) =>
  declaration?.id?.type === "Identifier" &&
  declaration.id.name === "Register" &&
  getStaticName(member.key) === "router" &&
  getTypeReferenceName(typeNode) === "ReturnType";

function isFrameworkMember(declaration, member) {
  if (isFunctionTypeMember(member)) return true;
  if (member.type !== "TSPropertySignature") return false;

  const name = getStaticName(member.key);
  const typeNode = member.typeAnnotation?.typeAnnotation;
  if (
    isFrameworkTypeReference(typeNode, { allowReadonly: true }) ||
    isFrameworkReturnTypeMember(declaration, member, typeNode)
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
  members.every((member) => isFrameworkMember(node, member));

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
  ((members.every((member) => isFrameworkMember(undefined, member)) &&
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
  (isCodexProviderProtocolFile(context.filename) &&
    getEnclosingDeclarationNames(node).some((declarationName) =>
      providerBoundarySchemaNames.has(declarationName)
    )) ||
  isProviderSchemaMetadata(context, node, name);

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

const schemaFirstDataContract = {
  meta: {
    messages: {
      schemaFirst: schemaFirstMessage,
    },
    type: "problem",
  },
  create(context) {
    const reportDeclaration = (node, members) => {
      if (
        !isAllCallable(members) &&
        !isFrameworkProps(context, node, members)
      ) {
        context.report({ messageId: "schemaFirst", node: node.id ?? node });
      }
    };

    return {
      TSInterfaceDeclaration(node) {
        reportDeclaration(node, node.body.body);
      },
      TSTypeAliasDeclaration(node) {
        if (node.typeAnnotation.type === "TSTypeLiteral") {
          reportDeclaration(node, node.typeAnnotation.members);
        }
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
