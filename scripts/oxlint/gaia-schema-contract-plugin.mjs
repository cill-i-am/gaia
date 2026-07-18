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

const getStructuralDeclarationMembers = (declaration) => {
  if (declaration?.type === "TSInterfaceDeclaration") {
    return declaration.body.body;
  }
  if (
    declaration?.type === "TSTypeAliasDeclaration" &&
    declaration.typeAnnotation.type === "TSTypeLiteral"
  ) {
    return declaration.typeAnnotation.members;
  }
  return undefined;
};

const hasStructuralDeclarationParameters = (declaration) =>
  getTypeParameters(declaration).length > 0 ||
  (declaration?.type === "TSInterfaceDeclaration" &&
    (declaration.extends?.length ?? 0) > 0);

const getUniqueStructuralDeclaration = (declarations, name) => {
  const candidates = declarations.get(name) ?? [];
  if (candidates.length !== 1) return undefined;
  const declaration = candidates[0];
  return getStructuralDeclarationMembers(declaration) === undefined ||
    hasStructuralDeclarationParameters(declaration)
    ? undefined
    : declaration;
};

const hasStructuralReferenceCycle = (
  declaration,
  declarations,
  active = new Set()
) => {
  if (active.has(declaration)) return true;
  const members = getStructuralDeclarationMembers(declaration);
  if (members === undefined) return false;
  const nextActive = new Set(active).add(declaration);
  let cycle = false;
  const visit = (node) => {
    if (cycle) return;
    if (
      node.type === "TSTypeReference" &&
      node.typeName.type === "Identifier"
    ) {
      const target = getUniqueStructuralDeclaration(
        declarations,
        node.typeName.name
      );
      if (
        target !== undefined &&
        hasStructuralReferenceCycle(target, declarations, nextActive)
      ) {
        cycle = true;
        return;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child?.type !== undefined) visit(child);
        }
      } else if (value?.type !== undefined) {
        visit(value);
      }
    }
  };
  for (const member of members) visit(member);
  return cycle;
};

const hasLocalTypeReferenceCycle = (
  node,
  declarations,
  classDeclarations,
  importedTypeBindingCounts,
  isGlobalReference,
  activeDeclarations
) => {
  let unsafe = false;
  const visitParameterType = (parameter, active) => {
    let current = parameter;
    while (current?.type !== undefined) {
      const annotation = current.typeAnnotation?.typeAnnotation;
      if (annotation !== undefined) {
        visit(annotation, active);
        return;
      }
      if (current.type === "AssignmentPattern") {
        current = current.left;
      } else if (current.type === "RestElement") {
        current = current.argument;
      } else if (current.type === "TSParameterProperty") {
        current = current.parameter;
      } else {
        return;
      }
    }
  };
  const visitClassMemberTypes = (member, active) => {
    if (member.static === true) return;
    if (
      member.type === "PropertyDefinition" ||
      member.type === "AccessorProperty"
    ) {
      visit(member.typeAnnotation?.typeAnnotation, active);
      return;
    }
    if (
      member.type !== "MethodDefinition" &&
      member.type !== "TSAbstractMethodDefinition"
    ) {
      return;
    }
    if (member.type === "MethodDefinition" && member.kind === "constructor") {
      for (const parameter of member.value.params) {
        if (parameter.type === "TSParameterProperty") {
          visitParameterType(parameter, active);
        }
      }
      return;
    }
    for (const typeParameter of getTypeParameters(member.value)) {
      visit(typeParameter.constraint, active);
      visit(typeParameter.default, active);
    }
    for (const parameter of member.value.params) {
      visitParameterType(parameter, active);
    }
    visit(member.value.returnType?.typeAnnotation, active);
  };
  const getQualifiedRoot = (typeName) => {
    let root = typeName;
    while (root?.type === "TSQualifiedName") root = root.left;
    return root?.type === "Identifier" ? root : undefined;
  };
  const visit = (current, active) => {
    if (unsafe || current?.type === undefined) return;
    if (current.type === "TSTypeReference") {
      if (current.typeName.type !== "Identifier") {
        const root = getQualifiedRoot(current.typeName);
        if (
          root === undefined ||
          importedTypeBindingCounts.get(root.name) !== 1
        ) {
          unsafe = true;
          return;
        }
      } else {
        const candidates = declarations.get(current.typeName.name) ?? [];
        if (candidates.length > 1) {
          unsafe = true;
          return;
        }
        const declaration = candidates[0];
        if (declaration !== undefined) {
          if (active.has(declaration)) {
            unsafe = true;
            return;
          }
          const nextActive = new Set(active).add(declaration);
          if (declaration.type === "TSInterfaceDeclaration") {
            for (const member of declaration.body.body) {
              visit(member, nextActive);
            }
          } else if (declaration.type === "TSTypeAliasDeclaration") {
            visit(declaration.typeAnnotation, nextActive);
          }
        } else {
          const classes = classDeclarations.get(current.typeName.name) ?? [];
          if (
            classes.length > 1 ||
            (classes.length === 0 &&
              importedTypeBindingCounts.get(current.typeName.name) !== 1 &&
              !isGlobalReference(current.typeName))
          ) {
            unsafe = true;
            return;
          }
          const classDeclaration = classes[0];
          if (classDeclaration !== undefined) {
            if (active.has(classDeclaration)) {
              unsafe = true;
              return;
            }
            const nextActive = new Set(active).add(classDeclaration);
            for (const member of classDeclaration.body.body) {
              visitClassMemberTypes(member, nextActive);
            }
          }
        }
      }
    }
    for (const key of Object.keys(current)) {
      if (key === "parent") continue;
      const value = current[key];
      if (Array.isArray(value)) {
        for (const child of value) visit(child, active);
      } else {
        visit(value, active);
      }
    }
  };
  visit(node, activeDeclarations);
  return unsafe;
};

const isCanonicalLocalSchemaClass = (
  node,
  declarations,
  classDeclarations,
  hasCanonicalSchemaBinding
) => {
  if (
    !hasCanonicalSchemaBinding ||
    node?.type !== "TSTypeReference" ||
    node.typeName.type !== "Identifier" ||
    getTypeParameters(node).length > 0
  ) {
    return false;
  }
  const candidates = classDeclarations.get(node.typeName.name) ?? [];
  if (
    candidates.length !== 1 ||
    (declarations.get(node.typeName.name)?.length ?? 0) > 0
  ) {
    return false;
  }
  const declaration = candidates[0];
  const schemaClass = declaration.superClass;
  const factory = schemaClass?.callee;
  const typeParameters = getTypeParameters(factory);
  return (
    getTypeParameters(declaration).length === 0 &&
    schemaClass?.type === "CallExpression" &&
    schemaClass.arguments.length === 1 &&
    schemaClass.arguments[0]?.type === "ObjectExpression" &&
    factory?.type === "CallExpression" &&
    factory.arguments.length === 1 &&
    typeParameters.length === 1 &&
    typeParameters[0].type === "TSTypeReference" &&
    typeParameters[0].typeName.type === "Identifier" &&
    typeParameters[0].typeName.name === declaration.id.name &&
    isSchemaMemberCall(factory, "Class")
  );
};

const isDirectIntersectionCapabilityAlias = (
  declaration,
  declarations,
  classDeclarations,
  importedTypeBindingCounts,
  isGlobalReference,
  hasCanonicalSchemaBinding
) => {
  if (
    declaration?.type !== "TSTypeAliasDeclaration" ||
    getTypeParameters(declaration).length > 0 ||
    declaration.typeAnnotation.type !== "TSIntersectionType" ||
    declaration.typeAnnotation.types.length !== 2
  ) {
    return false;
  }
  const callableArms = declaration.typeAnnotation.types.filter(
    (type) => type.type === "TSTypeLiteral" && isAllCallable(type.members)
  );
  const schemaArms = declaration.typeAnnotation.types.filter((type) =>
    isCanonicalLocalSchemaClass(
      type,
      declarations,
      classDeclarations,
      hasCanonicalSchemaBinding
    )
  );
  if (callableArms.length !== 1 || schemaArms.length !== 1) return false;
  return !hasLocalTypeReferenceCycle(
    callableArms[0],
    declarations,
    classDeclarations,
    importedTypeBindingCounts,
    isGlobalReference,
    new Set([declaration])
  );
};

const isCapabilityWrapperAlias = (
  node,
  declarations,
  classDeclarations,
  importedTypeBindingCounts,
  isGlobalReference,
  hasCanonicalSchemaBinding
) => {
  if (
    node.type !== "TSTypeAliasDeclaration" ||
    getTypeParameters(node).length > 0 ||
    node.typeAnnotation.type !== "TSTypeLiteral" ||
    node.typeAnnotation.members.length === 0
  ) {
    return false;
  }
  return node.typeAnnotation.members.every((member) => {
    if (
      member.type !== "TSPropertySignature" ||
      member.readonly !== true ||
      member.optional !== true
    ) {
      return false;
    }
    const reference = member.typeAnnotation?.typeAnnotation;
    if (
      reference?.type !== "TSTypeReference" ||
      reference.typeName.type !== "Identifier" ||
      getTypeParameters(reference).length > 0
    ) {
      return false;
    }
    const declaration = getUniqueStructuralDeclaration(
      declarations,
      reference.typeName.name
    );
    const members = getStructuralDeclarationMembers(declaration);
    const structuralCapability =
      declaration !== undefined &&
      declaration !== node &&
      members?.some(isFunctionTypeMember) === true &&
      !hasStructuralReferenceCycle(declaration, declarations);
    if (structuralCapability) return true;
    const intersectionCandidates =
      declarations.get(reference.typeName.name) ?? [];
    return (
      intersectionCandidates.length === 1 &&
      intersectionCandidates[0] !== node &&
      isDirectIntersectionCapabilityAlias(
        intersectionCandidates[0],
        declarations,
        classDeclarations,
        importedTypeBindingCounts,
        isGlobalReference,
        hasCanonicalSchemaBinding
      )
    );
  });
};

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
  if (pattern?.type === "TSParameterProperty") {
    return patternBindsName(pattern.parameter, name);
  }
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

const statementBindsName = (statement, name, includeImports = false) => {
  if (statement?.type === "VariableDeclaration") {
    return statement.declarations.some((declaration) =>
      patternBindsName(declaration.id, name)
    );
  }
  if (includeImports && statement?.type === "ImportDeclaration") {
    return (
      statement.importKind !== "type" &&
      statement.specifiers.some(
        (specifier) =>
          specifier.importKind !== "type" &&
          specifier.local.type === "Identifier" &&
          specifier.local.name === name
      )
    );
  }
  return (
    (statement?.type === "ClassDeclaration" ||
      statement?.type === "FunctionDeclaration") &&
    statement.id?.name === name
  );
};

const expressionBindsName = (expression, name) =>
  (expression.type === "ClassExpression" ||
    expression.type === "FunctionExpression") &&
  expression.id?.name === name;

const hasShadowingBinding = (call, name, includeImports = false) => {
  let current = call.parent;
  while (current !== undefined && current !== null) {
    if (expressionBindsName(current, name)) {
      return true;
    }
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
      current.body.some((statement) =>
        statementBindsName(statement, name, includeImports)
      )
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

const hasCounterfeitGlobalBinding = (node, name) =>
  hasShadowingBinding(node, name, true);

const statementBindsTypeName = (statement, name) => {
  if (
    statement?.type === "ExportNamedDeclaration" ||
    statement?.type === "ExportDefaultDeclaration"
  ) {
    return statementBindsTypeName(statement.declaration, name);
  }
  if (statement?.type === "ImportDeclaration") {
    return statement.specifiers.some(
      (specifier) =>
        specifier.local.type === "Identifier" && specifier.local.name === name
    );
  }
  return (
    (statement?.type === "ClassDeclaration" ||
      statement?.type === "TSInterfaceDeclaration" ||
      statement?.type === "TSTypeAliasDeclaration" ||
      statement?.type === "TSEnumDeclaration") &&
    statement.id?.name === name
  );
};

const hasShadowingTypeBinding = (node, name) => {
  let current = node.parent;
  while (current !== undefined && current !== null) {
    if (
      current.typeParameters?.type === "TSTypeParameterDeclaration" &&
      current.typeParameters.params.some(
        (parameter) => getStaticName(parameter.name) === name
      )
    ) {
      return true;
    }
    if (
      (current.type === "BlockStatement" || current.type === "Program") &&
      current.body.some((statement) => statementBindsTypeName(statement, name))
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

const walkAst = (node, visit) => {
  if (node?.type === undefined) return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit);
    } else {
      walkAst(value, visit);
    }
  }
};

const unwrapProgramDeclaration = (statement) =>
  statement.type === "ExportNamedDeclaration" ||
  statement.type === "ExportDefaultDeclaration"
    ? statement.declaration
    : statement;

const getTopLevelFunctions = (program) => {
  const functions = new Map();
  for (const statement of program.body) {
    const declaration = unwrapProgramDeclaration(statement);
    if (
      declaration?.type !== "FunctionDeclaration" ||
      declaration.id?.type !== "Identifier" ||
      declaration.body === undefined
    ) {
      continue;
    }
    const candidates = functions.get(declaration.id.name) ?? [];
    candidates.push(declaration);
    functions.set(declaration.id.name, candidates);
  }
  return functions;
};

const collectBindingIdentifiers = (program) => {
  const bindings = new Map();
  const remember = (identifier) => {
    if (identifier?.type !== "Identifier") return;
    const candidates = bindings.get(identifier.name) ?? [];
    candidates.push(identifier);
    bindings.set(identifier.name, candidates);
  };
  const rememberPattern = (pattern) => {
    if (pattern?.type === "TSParameterProperty") {
      rememberPattern(pattern.parameter);
    } else if (pattern?.type === "Identifier") {
      remember(pattern);
    } else if (pattern?.type === "AssignmentPattern") {
      rememberPattern(pattern.left);
    } else if (pattern?.type === "RestElement") {
      rememberPattern(pattern.argument);
    } else if (pattern?.type === "ArrayPattern") {
      for (const element of pattern.elements) rememberPattern(element);
    } else if (pattern?.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        rememberPattern(
          property.type === "RestElement" ? property.argument : property.value
        );
      }
    }
  };
  walkAst(program, (node) => {
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ClassDeclaration" ||
      node.type === "ClassExpression"
    ) {
      remember(node.id);
    }
    if (node.type === "VariableDeclarator") rememberPattern(node.id);
    if (
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression"
    ) {
      for (const parameter of node.params) rememberPattern(parameter);
    }
    if (node.type === "CatchClause") rememberPattern(node.param);
    if (
      node.type === "ImportDefaultSpecifier" ||
      node.type === "ImportNamespaceSpecifier" ||
      node.type === "ImportSpecifier"
    ) {
      remember(node.local);
    }
  });
  return bindings;
};

const hasUniqueCanonicalEffectSchemaBinding = (program) => {
  const schemaBindings = [];
  const canonicalBindings = [];
  const rememberPattern = (pattern) => {
    if (pattern?.type === "Identifier") {
      if (pattern.name === "Schema") schemaBindings.push(pattern);
      return;
    }
    if (pattern?.type === "AssignmentPattern") {
      rememberPattern(pattern.left);
    } else if (pattern?.type === "RestElement") {
      rememberPattern(pattern.argument);
    } else if (pattern?.type === "ArrayPattern") {
      for (const element of pattern.elements) rememberPattern(element);
    } else if (pattern?.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        rememberPattern(
          property.type === "RestElement" ? property.argument : property.value
        );
      }
    }
  };
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type") continue;
      for (const specifier of statement.specifiers) {
        if (
          specifier.importKind !== "type" &&
          specifier.local.type === "Identifier" &&
          specifier.local.name === "Schema"
        ) {
          schemaBindings.push(specifier.local);
          if (
            statement.source.value === "effect" &&
            specifier.type === "ImportSpecifier" &&
            getStaticName(specifier.imported) === "Schema"
          ) {
            canonicalBindings.push(specifier.local);
          }
        }
      }
      continue;
    }
    const declaration = unwrapProgramDeclaration(statement);
    if (
      declaration?.type === "ClassDeclaration" ||
      declaration?.type === "FunctionDeclaration"
    ) {
      if (declaration.id?.name === "Schema") {
        schemaBindings.push(declaration.id);
      }
    } else if (declaration?.type === "VariableDeclaration") {
      for (const candidate of declaration.declarations) {
        rememberPattern(candidate.id);
      }
    }
  }
  return schemaBindings.length === 1 && canonicalBindings.length === 1;
};

const isStaticPropertyIdentifier = (node) =>
  (node.parent?.type === "MemberExpression" &&
    node.parent.property === node &&
    !node.parent.computed) ||
  ((node.parent?.type === "Property" ||
    node.parent?.type === "PropertyDefinition" ||
    node.parent?.type === "TSPropertySignature") &&
    node.parent.key === node &&
    !node.parent.computed);

const getValueReferences = (program, name, bindings) => {
  const bindingNodes = new Set(bindings.get(name));
  const references = [];
  walkAst(program, (node) => {
    if (
      node.type === "Identifier" &&
      node.name === name &&
      !bindingNodes.has(node) &&
      !isStaticPropertyIdentifier(node) &&
      node.parent?.type !== "TSTypePredicate"
    ) {
      references.push(node);
    }
  });
  return references;
};

const isEffectSchemaImport = (program) =>
  program.body.some(
    (statement) =>
      statement.type === "ImportDeclaration" &&
      statement.source.value === "effect" &&
      statement.importKind !== "type" &&
      statement.specifiers.some(
        (specifier) =>
          specifier.type === "ImportSpecifier" &&
          specifier.importKind !== "type" &&
          getStaticName(specifier.imported) === "Schema" &&
          specifier.local.type === "Identifier" &&
          specifier.local.name === "Schema"
      )
  );

const isSchemaMemberCall = (node, memberName) =>
  node?.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  !node.callee.computed &&
  node.callee.object.type === "Identifier" &&
  node.callee.object.name === "Schema" &&
  getStaticName(node.callee.property) === memberName &&
  !hasShadowingBinding(node, "Schema");

const hasExactStringTypePredicate = (functionNode, parameter) => {
  const predicate = functionNode.returnType?.typeAnnotation;
  return (
    functionNode.params.length === 1 &&
    functionNode.params[0] === parameter &&
    predicate?.type === "TSTypePredicate" &&
    predicate.parameterName?.type === "Identifier" &&
    predicate.parameterName.name === parameter.name &&
    predicate.typeAnnotation?.typeAnnotation.type === "TSStringKeyword"
  );
};

const hasClosedRefinementBody = (functionNode) => {
  const parameter = functionNode.params[0];
  if (parameter?.type !== "Identifier") return false;
  const booleanMethodNames = new Set([
    "endsWith",
    "every",
    "has",
    "includes",
    "some",
    "startsWith",
    "test",
  ]);
  const comparisonOperators = new Set([
    "!=",
    "!==",
    "<",
    "<=",
    "==",
    "===",
    ">",
    ">=",
    "in",
    "instanceof",
  ]);
  const isBooleanValidationExpression = (node) => {
    if (node?.type === "Literal") return typeof node.value === "boolean";
    if (transparentCallableWrappers.has(node?.type)) {
      return isBooleanValidationExpression(node.expression);
    }
    if (node?.type === "CallExpression") {
      const methodName = getMemberCallName(node);
      return methodName !== undefined && booleanMethodNames.has(methodName);
    }
    if (node?.type === "BinaryExpression") {
      return comparisonOperators.has(node.operator);
    }
    if (node?.type === "LogicalExpression") {
      return (
        isBooleanValidationExpression(node.left) &&
        isBooleanValidationExpression(node.right)
      );
    }
    if (node?.type === "ConditionalExpression") {
      return (
        isBooleanValidationExpression(node.consequent) &&
        isBooleanValidationExpression(node.alternate)
      );
    }
    return node?.type === "UnaryExpression" && node.operator === "!";
  };
  const isClosedValidationUse = (node) => {
    const parent = node.parent;
    if (parent === undefined || parent === null) return false;
    if (transparentCallableWrappers.has(parent.type)) {
      return isClosedValidationUse(parent);
    }
    if (parent.type === "ReturnStatement" && parent.argument === node) {
      return isBooleanValidationExpression(node);
    }
    if (
      (parent.type === "IfStatement" && parent.test === node) ||
      (parent.type === "WhileStatement" && parent.test === node) ||
      (parent.type === "DoWhileStatement" && parent.test === node) ||
      (parent.type === "ForStatement" && parent.test === node) ||
      (parent.type === "SwitchStatement" && parent.discriminant === node)
    ) {
      return true;
    }
    if (parent.type === "MemberExpression" && parent.object === node) {
      if (
        (parent.parent?.type === "AssignmentExpression" &&
          parent.parent.left === parent) ||
        (parent.parent?.type === "UpdateExpression" &&
          parent.parent.argument === parent) ||
        (parent.parent?.type === "UnaryExpression" &&
          parent.parent.operator === "delete")
      ) {
        return false;
      }
      if (
        parent.parent?.type === "CallExpression" &&
        parent.parent.callee === parent &&
        isSafeTextMethodCall(parent.parent)
      ) {
        return isClosedValidationUse(parent.parent);
      }
      return isClosedValidationUse(parent);
    }
    if (
      parent.type === "BinaryExpression" ||
      parent.type === "ConditionalExpression" ||
      parent.type === "LogicalExpression" ||
      parent.type === "UnaryExpression"
    ) {
      return isClosedValidationUse(parent);
    }
    return false;
  };
  const urlBindings = new Map();
  walkAst(functionNode.body, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "NewExpression" &&
      node.init.callee.type === "Identifier" &&
      node.init.callee.name === "URL" &&
      !hasCounterfeitGlobalBinding(node.init, "URL") &&
      node.init.arguments.length === 1 &&
      node.init.arguments[0]?.type === "Identifier" &&
      node.init.arguments[0].name === parameter.name
    ) {
      const bindings = urlBindings.get(node.id.name) ?? [];
      bindings.push(node);
      urlBindings.set(node.id.name, bindings);
    }
  });
  let closed = true;
  walkAst(functionNode.body, (node) => {
    if (!closed || node.type !== "Identifier") return;
    if (node.name === parameter.name) {
      if (findEnclosingFunction(node) !== functionNode) {
        closed = false;
        return;
      }
      const parent = node.parent;
      if (
        parent?.type === "NewExpression" &&
        parent.arguments.length === 1 &&
        parent.arguments[0] === node &&
        parent.callee.type === "Identifier" &&
        parent.callee.name === "URL" &&
        !hasCounterfeitGlobalBinding(parent, "URL") &&
        parent.parent?.type === "VariableDeclarator" &&
        parent.parent.init === parent &&
        parent.parent.id.type === "Identifier" &&
        urlBindings.get(parent.parent.id.name)?.length === 1 &&
        urlBindings.get(parent.parent.id.name)?.[0] === parent.parent
      ) {
        return;
      }
      if (
        parent?.type === "MemberExpression" &&
        parent.object === node &&
        parent.parent?.type === "CallExpression" &&
        parent.parent.callee === parent &&
        isSafeTextMethodCall(parent.parent) &&
        isClosedValidationUse(parent.parent)
      ) {
        return;
      }
      closed = false;
      return;
    }
    const bindings = urlBindings.get(node.name);
    if (bindings?.length !== 1 || bindings[0].id === node) return;
    const parent = node.parent;
    if (
      findEnclosingFunction(node) !== functionNode ||
      parent?.type !== "MemberExpression" ||
      parent.object !== node ||
      !isClosedValidationUse(parent)
    ) {
      closed = false;
    }
  });
  return closed;
};

const isCanonicalSchemaRefinement = (
  program,
  functionNode,
  parameter,
  bindings
) => {
  if (
    !isEffectSchemaImport(program) ||
    functionNode.type !== "FunctionDeclaration" ||
    functionNode.id?.type !== "Identifier" ||
    (bindings.get(functionNode.id.name)?.length ?? 0) !== 1 ||
    !hasExactStringTypePredicate(functionNode, parameter) ||
    !hasClosedRefinementBody(functionNode)
  ) {
    return false;
  }
  const references = getValueReferences(
    program,
    functionNode.id.name,
    bindings
  );
  if (references.length !== 1) return false;
  const reference = references[0];
  const refineCall = reference.parent;
  if (
    !isSchemaMemberCall(refineCall, "refine") ||
    refineCall.arguments[0] !== reference
  ) {
    return false;
  }
  const pipeCall = refineCall.parent;
  if (
    pipeCall?.type !== "CallExpression" ||
    !pipeCall.arguments.includes(refineCall) ||
    pipeCall.callee.type !== "MemberExpression" ||
    pipeCall.callee.computed ||
    getStaticName(pipeCall.callee.property) !== "pipe" ||
    !isDirectUnbrandedSchemaString(pipeCall.callee.object) ||
    hasShadowingBinding(pipeCall, "Schema")
  ) {
    return false;
  }
  const refinementIndex = pipeCall.arguments.indexOf(refineCall);
  return pipeCall.arguments.some(
    (argument, index) =>
      index > refinementIndex &&
      isSchemaMemberCall(argument, "brand") &&
      argument.arguments.length === 1 &&
      argument.arguments[0]?.type === "Literal" &&
      typeof argument.arguments[0].value === "string" &&
      argument.arguments[0].value.length > 0
  );
};

const safeTextMethodNames = new Set([
  "add",
  "at",
  "charCodeAt",
  "concat",
  "endsWith",
  "every",
  "exec",
  "filter",
  "find",
  "flatMap",
  "forEach",
  "has",
  "includes",
  "indexOf",
  "join",
  "map",
  "match",
  "min",
  "push",
  "reduce",
  "replace",
  "replaceAll",
  "slice",
  "some",
  "split",
  "startsWith",
  "substring",
  "test",
  "toLowerCase",
  "toUpperCase",
  "trim",
]);
const getMemberCallName = (node) =>
  node?.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  !node.callee.computed
    ? getStaticName(node.callee.property)
    : undefined;

const isSafeTextMethodCall = (node) =>
  safeTextMethodNames.has(getMemberCallName(node));

const isSchemaOrProseMakeCall = (node) => getMemberCallName(node) === "make";

const createClosedTextGraph = (program, bindings) => {
  const functions = getTopLevelFunctions(program);
  const functionAliases = new Map();
  const aliasDeclarations = [];
  walkAst(program, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "Identifier" &&
      (bindings.get(node.id.name)?.length ?? 0) === 1
    ) {
      aliasDeclarations.push(node);
    }
  });
  let remainingAliasPasses = aliasDeclarations.length;
  while (remainingAliasPasses > 0) {
    let changed = false;
    for (const node of aliasDeclarations) {
      if (functionAliases.has(node.id.name)) continue;
      const direct = functions.get(node.init.name);
      const target =
        direct?.length === 1 ? direct[0] : functionAliases.get(node.init.name);
      if (target !== undefined) {
        functionAliases.set(node.id.name, target);
        changed = true;
      }
    }
    if (!changed) break;
    remainingAliasPasses -= 1;
  }

  const resolveFunction = (name) => {
    const direct = functions.get(name);
    return direct?.length === 1 ? direct[0] : functionAliases.get(name);
  };
  const findVisibleValueBinding = (node, name) => {
    let current = node.parent;
    while (current !== undefined && current !== null) {
      if (
        current.type === "ArrowFunctionExpression" ||
        current.type === "FunctionDeclaration" ||
        current.type === "FunctionExpression"
      ) {
        const parameter = current.params.find((candidate) =>
          patternBindsName(candidate, name)
        );
        if (parameter !== undefined) return { parameter };
      }
      if (
        (current.type === "ForInStatement" ||
          current.type === "ForOfStatement") &&
        current.left.type === "VariableDeclaration" &&
        current.left.declarations.some((declaration) =>
          patternBindsName(declaration.id, name)
        )
      ) {
        return { initializer: current.right };
      }
      if (current.type === "BlockStatement" || current.type === "Program") {
        const declarations = [];
        for (const statement of current.body) {
          const declaration = unwrapProgramDeclaration(statement);
          if (declaration?.type !== "VariableDeclaration") continue;
          for (const candidate of declaration.declarations) {
            if (
              candidate.id.type === "Identifier" &&
              candidate.id.name === name &&
              (current.type === "Program" || candidate.start < node.start)
            ) {
              declarations.push(candidate);
            }
          }
        }
        if (declarations.length === 1) {
          return {
            declaration: declarations[0],
            initializer: declarations[0].init ?? undefined,
          };
        }
        if (declarations.length > 1) return undefined;
      }
      current = current.parent;
    }
    return undefined;
  };
  const closedBuiltinCollectionTypes = new Set([
    "Array",
    "ReadonlyArray",
    "ReadonlySet",
    "Set",
  ]);
  const isClosedBuiltinCollectionType = (type) => {
    if (type?.type === "TSArrayType") return true;
    const typeName = getTypeReferenceName(type);
    const typeParameters = getTypeParameters(type);
    return (
      typeName !== undefined &&
      closedBuiltinCollectionTypes.has(typeName) &&
      typeParameters.length === 1 &&
      !hasShadowingTypeBinding(type, typeName)
    );
  };
  const getClosedBuiltinCollectionElement = (type) => {
    if (type?.type === "TSArrayType") return type.elementType;
    const typeName = getTypeReferenceName(type);
    const typeParameters = getTypeParameters(type);
    return typeName !== undefined &&
      closedBuiltinCollectionTypes.has(typeName) &&
      typeParameters.length === 1 &&
      !hasShadowingTypeBinding(type, typeName)
      ? typeParameters[0]
      : undefined;
  };
  const ordinaryTextSchemaWrappers = new Set([
    "Array",
    "NonEmptyArray",
    "optional",
    "optionalKey",
  ]);
  const isOrdinaryUnbrandedTextSchema = (node) => {
    if (
      isDirectUnbrandedSchemaString(node) &&
      !hasShadowingBinding(node, "Schema")
    ) {
      return true;
    }
    const memberName = getMemberCallName(node);
    return (
      memberName !== undefined &&
      ordinaryTextSchemaWrappers.has(memberName) &&
      isSchemaMemberCall(node, memberName) &&
      node.arguments.length === 1 &&
      isOrdinaryUnbrandedTextSchema(node.arguments[0])
    );
  };
  const schemaClassFields = new Map();
  const getSchemaCollectionElement = (node) => {
    const memberName = getMemberCallName(node);
    return (memberName === "Array" || memberName === "NonEmptyArray") &&
      isSchemaMemberCall(node, memberName) &&
      node.arguments.length === 1
      ? node.arguments[0]
      : undefined;
  };
  const getCallbackSource = (parameter) => {
    const callable = parameter.parent;
    const call = callable?.parent;
    return (callable?.type === "ArrowFunctionExpression" ||
      callable?.type === "FunctionExpression") &&
      callable.params[0] === parameter &&
      call?.type === "CallExpression" &&
      call.arguments.includes(callable) &&
      isSafeTextMethodCall(call)
      ? call.callee.object
      : undefined;
  };
  const getEffectiveParameterType = (
    parameter,
    activeParameters = new Set()
  ) => {
    const direct = parameter.typeAnnotation?.typeAnnotation;
    if (direct !== undefined || activeParameters.has(parameter)) return direct;
    const source = getCallbackSource(parameter);
    return source === undefined
      ? undefined
      : getDeclaredCollectionElement(
          source,
          new Set(activeParameters).add(parameter)
        );
  };
  const getEffectiveTypeName = (type) =>
    getTypeReferenceName(type) ??
    (type?.type === "Identifier" ? type.name : undefined);
  const getSchemaClassField = (
    parameter,
    fieldName,
    activeParameters = new Set()
  ) => {
    const typeName = getEffectiveTypeName(
      getEffectiveParameterType(parameter, activeParameters)
    );
    if (typeName === undefined) return undefined;
    const candidates = schemaClassFields.get(typeName) ?? [];
    return candidates.length === 1 ? candidates[0].get(fieldName) : undefined;
  };
  const getTypedLiteralFieldType = (
    parameter,
    fieldName,
    activeParameters = new Set()
  ) => {
    const type = getEffectiveParameterType(parameter, activeParameters);
    if (type?.type !== "TSTypeLiteral") return undefined;
    const fields = type.members.filter(
      (member) =>
        member.type === "TSPropertySignature" &&
        member.readonly === true &&
        member.optional !== true &&
        getStaticName(member.key) === fieldName
    );
    return fields.length === 1
      ? fields[0].typeAnnotation?.typeAnnotation
      : undefined;
  };
  const getDirectReturnValues = (target) => {
    const returnValues = [];
    walkAst(target.body, (node) => {
      if (node.type !== "ReturnStatement") return;
      let owner = node.parent;
      while (owner !== undefined && owner !== null) {
        if (callableNodeTypes.has(owner.type)) break;
        owner = owner.parent;
      }
      if (owner === target && node.argument !== null) {
        returnValues.push(node.argument);
      }
    });
    return returnValues;
  };
  const getCallableReturnValues = (callable) =>
    callable.body.type === "BlockStatement"
      ? getDirectReturnValues(callable)
      : [callable.body];
  const collectionElementPreservingMethods = new Set(["filter", "slice"]);
  const stringCollectionProducingMethods = new Set(["match", "split"]);
  const structurallyClosedCollectionElement = Symbol(
    "structurallyClosedCollectionElement"
  );
  function getDeclaredCollectionElement(
    node,
    activeParameters = new Set(),
    activeFunctions = new Set()
  ) {
    if (node === undefined || node === null || activeFunctions.has(node)) {
      return undefined;
    }
    activeFunctions = new Set(activeFunctions).add(node);
    if (
      node?.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "Set" &&
      !hasCounterfeitGlobalBinding(node, "Set") &&
      node.arguments.length === 1
    ) {
      const argument = node.arguments[0];
      return getDeclaredCollectionElement(
        argument.type === "SpreadElement" ? argument.argument : argument,
        activeParameters,
        activeFunctions
      );
    }
    if (node?.type === "ArrayExpression") {
      if (
        node.elements.length === 1 &&
        node.elements[0]?.type === "SpreadElement"
      ) {
        return getDeclaredCollectionElement(
          node.elements[0].argument,
          activeParameters,
          activeFunctions
        );
      }
      return node.elements.every(
        (element) =>
          element === null ||
          isClosedReceiver(
            element.type === "SpreadElement" ? element.argument : element
          )
      )
        ? structurallyClosedCollectionElement
        : undefined;
    }
    if (
      node?.type === "ConditionalExpression" ||
      node?.type === "LogicalExpression"
    ) {
      const branches =
        node.type === "ConditionalExpression"
          ? [node.consequent, node.alternate]
          : [node.left, node.right];
      const elements = branches.map((branch) =>
        getDeclaredCollectionElement(branch, activeParameters, activeFunctions)
      );
      if (elements.some((element) => element === undefined)) return undefined;
      return (
        elements.find((element) => !isClosedCallbackElement(element)) ??
        elements[0]
      );
    }
    if (
      node?.type === "CallExpression" &&
      node.callee.type === "MemberExpression"
    ) {
      const methodName = getMemberCallName(node);
      if (
        methodName !== undefined &&
        stringCollectionProducingMethods.has(methodName) &&
        isClosedReceiver(node.callee.object)
      ) {
        return structurallyClosedCollectionElement;
      }
      if (
        methodName !== undefined &&
        collectionElementPreservingMethods.has(methodName)
      ) {
        return getDeclaredCollectionElement(
          node.callee.object,
          activeParameters,
          activeFunctions
        );
      }
      if (methodName === "map" || methodName === "flatMap") {
        const callback = node.arguments[0];
        const target =
          callback?.type === "Identifier"
            ? resolveFunction(callback.name)
            : callback?.type === "ArrowFunctionExpression" ||
                callback?.type === "FunctionExpression"
              ? callback
              : undefined;
        if (
          target === undefined ||
          activeFunctions.has(target) ||
          getDeclaredCollectionElement(
            node.callee.object,
            activeParameters,
            activeFunctions
          ) === undefined
        ) {
          return undefined;
        }
        const nextFunctions = new Set(activeFunctions).add(target);
        const elements = getCallableReturnValues(target).map((value) =>
          methodName === "flatMap"
            ? getDeclaredCollectionElement(
                value,
                activeParameters,
                nextFunctions
              )
            : isClosedReceiver(value)
              ? structurallyClosedCollectionElement
              : undefined
        );
        if (
          elements.length === 0 ||
          elements.some((element) => element === undefined)
        ) {
          return undefined;
        }
        return (
          elements.find((element) => !isClosedCallbackElement(element)) ??
          elements[0]
        );
      }
    }
    if (node?.type === "CallExpression" && node.callee.type === "Identifier") {
      const target = resolveFunction(node.callee.name);
      if (target !== undefined && !activeFunctions.has(target)) {
        const nextFunctions = new Set(activeFunctions).add(target);
        const elements = getDirectReturnValues(target).map((value) => {
          const element = getDeclaredCollectionElement(
            value,
            activeParameters,
            nextFunctions
          );
          if (element !== undefined || value.type !== "Identifier") {
            return element;
          }
          const binding = findVisibleValueBinding(value, value.name);
          const parameterIndex = target.params.indexOf(binding?.parameter);
          const argument = node.arguments[parameterIndex];
          return parameterIndex < 0 || argument === undefined
            ? undefined
            : getDeclaredCollectionElement(
                argument.type === "SpreadElement"
                  ? argument.argument
                  : argument,
                activeParameters,
                nextFunctions
              );
        });
        if (
          elements.length === 0 ||
          elements.some((element) => element === undefined)
        ) {
          return undefined;
        }
        return (
          elements.find((element) => !isClosedCallbackElement(element)) ??
          elements[0]
        );
      }
    }
    if (node?.type === "Identifier") {
      const binding = findVisibleValueBinding(node, node.name);
      if (binding?.parameter !== undefined) {
        return getClosedBuiltinCollectionElement(
          getEffectiveParameterType(binding.parameter, activeParameters)
        );
      }
      return binding?.initializer === undefined
        ? undefined
        : getDeclaredCollectionElement(
            binding.initializer,
            activeParameters,
            activeFunctions
          );
    }
    if (
      node?.type !== "MemberExpression" ||
      node.object.type !== "Identifier"
    ) {
      return undefined;
    }
    const binding = findVisibleValueBinding(node.object, node.object.name);
    const parameter = binding?.parameter;
    const fieldName = getStaticName(node.property);
    if (parameter === undefined || fieldName === undefined) return undefined;
    const schemaField = getSchemaClassField(
      parameter,
      fieldName,
      activeParameters
    );
    return (
      getSchemaCollectionElement(schemaField) ??
      getClosedBuiltinCollectionElement(
        getTypedLiteralFieldType(parameter, fieldName, activeParameters)
      )
    );
  }
  const isClosedCallbackElement = (element) =>
    element === structurallyClosedCollectionElement ||
    element?.type === "TSStringKeyword" ||
    isDirectUnbrandedSchemaString(element) ||
    isClosedBuiltinCollectionType(element) ||
    getSchemaCollectionElement(element) !== undefined;
  const isClosedSchemaFieldReceiver = (node) => {
    if (node.object.type !== "Identifier") return false;
    const binding = findVisibleValueBinding(node.object, node.object.name);
    const parameter = binding?.parameter;
    if (parameter === undefined) return false;
    const fieldName = getStaticName(node.property);
    if (fieldName === undefined) return false;
    const field = getSchemaClassField(parameter, fieldName);
    return (
      field !== undefined &&
      (isOrdinaryUnbrandedTextSchema(field) ||
        getSchemaCollectionElement(field) !== undefined)
    );
  };
  const isClosedTypedMemberReceiver = (node) => {
    if (node.object.type !== "Identifier") return false;
    const binding = findVisibleValueBinding(node.object, node.object.name);
    const parameter = binding?.parameter;
    if (parameter === undefined) return false;
    const fieldName = getStaticName(node.property);
    return (
      fieldName !== undefined &&
      isClosedBuiltinCollectionType(
        getTypedLiteralFieldType(parameter, fieldName)
      )
    );
  };
  const isClosedParameterReceiver = (parameter, activeBindings) => {
    const parameterType = parameter.typeAnnotation?.typeAnnotation;
    if (
      (parameter.type === "Identifier" && isStringTypeAnnotation(parameter)) ||
      (parameter.type === "Identifier" &&
        (parameterType?.type === "TSBooleanKeyword" ||
          parameterType?.type === "TSNumberKeyword")) ||
      (parameter.type === "Identifier" &&
        isClosedBuiltinCollectionType(parameterType))
    ) {
      return true;
    }
    const source = getCallbackSource(parameter);
    if (source === undefined || !isClosedReceiver(source, activeBindings)) {
      return false;
    }
    const declaredElement = getDeclaredCollectionElement(source);
    return (
      declaredElement !== undefined && isClosedCallbackElement(declaredElement)
    );
  };
  let isClosedFunctionCall = () => false;
  let isClosedFunctionMemberCall = () => false;
  const isClosedReceiver = (node, activeBindings = new Set()) => {
    if (node?.type === "Literal" || node?.type === "TemplateLiteral") {
      return true;
    }
    if (node?.type === "Identifier") {
      if (
        (node.name === "Math" || node.name === "String") &&
        !hasCounterfeitGlobalBinding(node, node.name)
      ) {
        return true;
      }
      const binding = findVisibleValueBinding(node, node.name);
      if (binding?.parameter !== undefined) {
        return isClosedParameterReceiver(binding.parameter, activeBindings);
      }
      if (
        binding?.initializer !== undefined &&
        !activeBindings.has(binding.initializer)
      ) {
        return isClosedReceiver(
          binding.initializer,
          new Set(activeBindings).add(binding.initializer)
        );
      }
      return false;
    }
    if (node?.type === "MemberExpression") {
      if (
        node.object.type === "CallExpression" &&
        node.object.callee.type === "Identifier"
      ) {
        const target = resolveFunction(node.object.callee.name);
        const fieldName = getStaticName(node.property);
        if (
          target !== undefined &&
          fieldName !== undefined &&
          isClosedFunctionMemberCall(
            node.object,
            target,
            fieldName,
            activeBindings
          )
        ) {
          return true;
        }
      }
      return (
        isClosedSchemaFieldReceiver(node) ||
        isClosedTypedMemberReceiver(node) ||
        isClosedReceiver(node.object, activeBindings)
      );
    }
    if (node?.type === "CallExpression") {
      if (node.callee.type === "Identifier") {
        const target = resolveFunction(node.callee.name);
        if (target !== undefined) {
          return isClosedFunctionCall(node, target, activeBindings);
        }
      }
      return (
        isSafeTextMethodCall(node) &&
        isClosedReceiver(node.callee.object, activeBindings)
      );
    }
    if (node?.type === "NewExpression") {
      return (
        node.callee.type === "Identifier" &&
        (node.callee.name === "Set" || node.callee.name === "RegExp") &&
        !hasCounterfeitGlobalBinding(node, node.callee.name) &&
        node.arguments.every((argument) =>
          isClosedReceiver(
            argument.type === "SpreadElement" ? argument.argument : argument,
            activeBindings
          )
        )
      );
    }
    if (node?.type === "ObjectExpression") {
      return node.properties.every((property) => {
        if (property.type === "SpreadElement") {
          return isClosedReceiver(property.argument, activeBindings);
        }
        return (
          property.type === "Property" &&
          property.kind === "init" &&
          isClosedReceiver(property.value, activeBindings)
        );
      });
    }
    if (node?.type === "ArrayExpression") {
      return node.elements.every(
        (element) =>
          element === null ||
          isClosedReceiver(
            element.type === "SpreadElement" ? element.argument : element,
            activeBindings
          )
      );
    }
    if (node?.type === "ConditionalExpression") {
      return (
        isClosedReceiver(node.consequent, activeBindings) &&
        isClosedReceiver(node.alternate, activeBindings)
      );
    }
    if (node?.type === "BinaryExpression") {
      return (
        isClosedReceiver(node.left, activeBindings) &&
        isClosedReceiver(node.right, activeBindings)
      );
    }
    if (node?.type === "UnaryExpression") {
      return isClosedReceiver(node.argument, activeBindings);
    }
    if (
      node?.type === "ChainExpression" ||
      node?.type === "LogicalExpression" ||
      transparentCallableWrappers.has(node?.type)
    ) {
      const children = [];
      for (const key of Object.keys(node)) {
        if (key === "parent") continue;
        const value = node[key];
        if (Array.isArray(value)) {
          children.push(...value.filter((child) => child?.type !== undefined));
        } else if (value?.type !== undefined) {
          children.push(value);
        }
      }
      return (
        children.length > 0 &&
        children.every((child) => isClosedReceiver(child, activeBindings))
      );
    }
    return false;
  };
  const getOrdinaryTextFields = (classNode) => {
    const schemaClass = classNode.superClass;
    if (
      schemaClass?.type !== "CallExpression" ||
      schemaClass.arguments.length !== 1 ||
      schemaClass.arguments[0]?.type !== "ObjectExpression" ||
      schemaClass.callee.type !== "CallExpression" ||
      !isSchemaMemberCall(schemaClass.callee, "Class")
    ) {
      return undefined;
    }
    const fields = new Map();
    for (const property of schemaClass.arguments[0].properties) {
      if (property.type !== "Property" || property.kind !== "init") {
        return undefined;
      }
      const name = getStaticName(property.key);
      if (name === undefined || fields.has(name)) return undefined;
      fields.set(name, property.value);
    }
    return fields;
  };
  if (isEffectSchemaImport(program)) {
    walkAst(program, (node) => {
      if (node.type !== "ClassDeclaration" || node.id?.type !== "Identifier") {
        return;
      }
      const fields = getOrdinaryTextFields(node);
      if (fields === undefined) return;
      const candidates = schemaClassFields.get(node.id.name) ?? [];
      candidates.push(fields);
      schemaClassFields.set(node.id.name, candidates);
    });
  }
  const getCanonicalSchemaMakeFields = (node) => {
    if (
      !isSchemaOrProseMakeCall(node) ||
      node.callee.object.type !== "Identifier" ||
      (bindings.get(node.callee.object.name)?.length ?? 0) !== 1
    ) {
      return undefined;
    }
    const candidates = schemaClassFields.get(node.callee.object.name) ?? [];
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const isCanonicalSchemaMakeCall = (node) =>
    getCanonicalSchemaMakeFields(node) !== undefined;
  const getEnclosingTopLevelFunction = (node) => {
    let current = node.parent;
    while (current !== undefined && current !== null) {
      if (current.type === "FunctionDeclaration") {
        return current.id?.type === "Identifier" &&
          functions.get(current.id.name)?.length === 1 &&
          functions.get(current.id.name)[0] === current
          ? current
          : undefined;
      }
      current = current.parent;
    }
    return undefined;
  };
  const analyses = new Map();
  const analyzeFunction = (functionNode) => {
    const current = analyses.get(functionNode);
    if (current === "visiting") {
      return {
        functions: new Set([functionNode]),
        safe: true,
        transformed: false,
      };
    }
    if (current !== undefined) return current;
    analyses.set(functionNode, "visiting");
    let safe = true;
    let transformed = false;
    const analyzedFunctions = new Set([functionNode]);
    const stringParameters = new Set(
      functionNode.params
        .filter(
          (parameter) =>
            parameter.type === "Identifier" && isStringTypeAnnotation(parameter)
        )
        .map((parameter) => parameter.name)
    );
    walkAst(functionNode.body, (node) => {
      if (!safe) return;
      if (
        node.type === "MemberExpression" &&
        node.object.type === "Identifier" &&
        stringParameters.has(node.object.name)
      ) {
        transformed = true;
      }
      if (node.type === "NewExpression") {
        if (
          node.callee.type !== "Identifier" ||
          (node.callee.name !== "Set" && node.callee.name !== "RegExp") ||
          hasCounterfeitGlobalBinding(node, node.callee.name)
        ) {
          safe = false;
        } else {
          transformed = true;
        }
      }
      if (node.type !== "CallExpression") return;
      if (isSafeTextMethodCall(node) && isClosedReceiver(node.callee.object)) {
        transformed = true;
        return;
      }
      if (isCanonicalSchemaMakeCall(node)) {
        return;
      }
      if (node.callee.type === "Identifier") {
        const target = resolveFunction(node.callee.name);
        if (target !== undefined) {
          const result = analyzeFunction(target);
          safe &&= result.safe;
          transformed ||= result.transformed;
          for (const candidate of result.functions) {
            analyzedFunctions.add(candidate);
          }
          return;
        }
        if (
          (node.callee.name === "String" ||
            node.callee.name === "Boolean" ||
            node.callee.name === "Number") &&
          !hasCounterfeitGlobalBinding(node, node.callee.name)
        ) {
          transformed = true;
          return;
        }
      }
      safe = false;
    });
    const result = { functions: analyzedFunctions, safe, transformed };
    analyses.set(functionNode, result);
    return result;
  };
  isClosedFunctionCall = (_call, target, activeBindings) => {
    if (activeBindings.has(target) || analyses.get(target) === "visiting") {
      return true;
    }
    const analysis = analyzeFunction(target);
    if (!analysis.safe || !analysis.transformed) return false;
    const returnValues = [];
    walkAst(target.body, (node) => {
      if (node.type !== "ReturnStatement") return;
      let owner = node.parent;
      while (owner !== undefined && owner !== null) {
        if (callableNodeTypes.has(owner.type)) break;
        owner = owner.parent;
      }
      if (owner === target && node.argument !== null) {
        returnValues.push(node.argument);
      }
    });
    const returnState = new Set(activeBindings).add(target);
    const isClosedReturnValue = (value) => {
      if (value.type === "Identifier") {
        const binding = findVisibleValueBinding(value, value.name);
        const parameter = binding?.parameter;
        if (parameter !== undefined) {
          const element = getClosedBuiltinCollectionElement(
            getEffectiveParameterType(parameter)
          );
          if (element !== undefined) return isClosedCallbackElement(element);
        }
      }
      if (
        value.type === "NewExpression" &&
        value.callee.type === "Identifier" &&
        value.callee.name === "Set"
      ) {
        const element = getDeclaredCollectionElement(value);
        if (element !== undefined && !isClosedCallbackElement(element)) {
          return false;
        }
      }
      if (value.type === "ArrayExpression") {
        return value.elements.every(
          (element) =>
            element === null ||
            isClosedReturnValue(
              element.type === "SpreadElement" ? element.argument : element
            )
        );
      }
      if (value.type === "ObjectExpression") {
        return value.properties.every((property) =>
          property.type === "SpreadElement"
            ? isClosedReturnValue(property.argument)
            : property.type === "Property" &&
              property.kind === "init" &&
              isClosedReturnValue(property.value)
        );
      }
      if (
        value.type === "ConditionalExpression" ||
        value.type === "LogicalExpression"
      ) {
        const branches =
          value.type === "ConditionalExpression"
            ? [value.consequent, value.alternate]
            : [value.left, value.right];
        return branches.every(isClosedReturnValue);
      }
      return isClosedReceiver(value, returnState);
    };
    return returnValues.length > 0 && returnValues.every(isClosedReturnValue);
  };
  isClosedFunctionMemberCall = (_call, target, fieldName, activeBindings) => {
    if (activeBindings.has(target)) return true;
    const analysis = analyzeFunction(target);
    if (!analysis.safe || !analysis.transformed) return false;
    const fieldValues = [];
    let unsupportedReturn = false;
    walkAst(target.body, (node) => {
      if (node.type !== "ReturnStatement") return;
      let owner = node.parent;
      while (owner !== undefined && owner !== null) {
        if (callableNodeTypes.has(owner.type)) break;
        owner = owner.parent;
      }
      if (owner !== target || node.argument === null) return;
      if (node.argument.type !== "ObjectExpression") {
        unsupportedReturn = true;
        return;
      }
      const property = node.argument.properties.find(
        (candidate) =>
          candidate.type === "Property" &&
          candidate.kind === "init" &&
          getStaticName(candidate.key) === fieldName
      );
      if (property === undefined) {
        unsupportedReturn = true;
        return;
      }
      fieldValues.push(property.value);
    });
    const returnState = new Set(activeBindings).add(target);
    return (
      !unsupportedReturn &&
      fieldValues.length > 0 &&
      fieldValues.every((value) => isClosedReceiver(value, returnState))
    );
  };

  const isFunctionReferenceSafe = (functionNode) => {
    const names = [
      functionNode.id?.name,
      ...[...functionAliases.entries()]
        .filter(([, target]) => target === functionNode)
        .map(([name]) => name),
    ].filter(Boolean);
    let referenceCount = 0;
    for (const name of names) {
      for (const reference of getValueReferences(program, name, bindings)) {
        if (
          reference.parent?.type === "VariableDeclarator" &&
          reference.parent.init === reference &&
          functionAliases.has(reference.parent.id?.name)
        ) {
          continue;
        }
        referenceCount += 1;
        const parent = reference.parent;
        if (parent?.type === "CallExpression" && parent.callee === reference) {
          continue;
        }
        if (
          parent?.type === "CallExpression" &&
          parent.arguments.includes(reference) &&
          isSafeTextMethodCall(parent) &&
          isClosedReceiver(parent.callee.object)
        ) {
          continue;
        }
        return false;
      }
    }
    return referenceCount > 0;
  };

  const directlyTransformsParameter = (functionNode, parameter) => {
    let transformed = false;
    walkAst(functionNode.body, (node) => {
      if (
        node.type === "MemberExpression" &&
        node.object.type === "Identifier" &&
        node.object.name === parameter.name
      ) {
        transformed = true;
      }
    });
    return transformed;
  };

  const isClosed = (functionNode, parameter) => {
    const analysis = analyzeFunction(functionNode);
    const stringParameterCount = functionNode.params.filter(
      (candidate) =>
        candidate.type === "Identifier" && isStringTypeAnnotation(candidate)
    ).length;
    if (
      !analysis.safe ||
      !analysis.transformed ||
      (stringParameterCount > 1 &&
        !directlyTransformsParameter(functionNode, parameter)) ||
      !isFunctionReferenceSafe(functionNode)
    ) {
      return false;
    }
    const graphFunctions = analysis.functions;
    for (const candidate of graphFunctions) {
      if (!isFunctionReferenceSafe(candidate)) {
        return false;
      }
    }

    const graphNames = new Set();
    for (const candidate of graphFunctions) {
      if (candidate.id?.name !== undefined) graphNames.add(candidate.id.name);
    }
    for (const [alias, target] of functionAliases) {
      if (graphFunctions.has(target)) graphNames.add(alias);
    }
    const variableDeclarationsByScope = new Map();
    walkAst(program, (node) => {
      if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") {
        return;
      }
      const scope = findEnclosingFunction(node) ?? program;
      const declarations = variableDeclarationsByScope.get(scope) ?? new Map();
      const named = declarations.get(node.id.name) ?? [];
      named.push(node);
      declarations.set(node.id.name, named);
      variableDeclarationsByScope.set(scope, declarations);
    });
    const resolveVariable = (identifier) => {
      if (
        identifier.type !== "Identifier" ||
        isStaticPropertyIdentifier(identifier)
      ) {
        return undefined;
      }
      const visible = findVisibleValueBinding(identifier, identifier.name);
      if (visible?.declaration !== undefined) {
        return visible.declaration;
      }
      const scope = findEnclosingFunction(identifier) ?? program;
      const candidates =
        variableDeclarationsByScope.get(scope)?.get(identifier.name) ?? [];
      return candidates.length === 1 && candidates[0].start < identifier.start
        ? candidates[0]
        : undefined;
    };
    const assignmentsByDeclaration = new Map();
    walkAst(program, (node) => {
      if (
        node.type !== "AssignmentExpression" ||
        node.left.type !== "Identifier"
      ) {
        return;
      }
      const declaration = resolveVariable(node.left);
      if (declaration === undefined) return;
      const assignments = assignmentsByDeclaration.get(declaration) ?? [];
      assignments.push(node);
      assignmentsByDeclaration.set(declaration, assignments);
    });
    const walkCandidateValue = (node, visit) => {
      if (node?.type === undefined) return;
      visit(node);
      if (callableNodeTypes.has(node.type) || isCanonicalSchemaMakeCall(node)) {
        return;
      }
      for (const key of Object.keys(node)) {
        if (key === "parent") continue;
        const value = node[key];
        if (Array.isArray(value)) {
          for (const child of value) walkCandidateValue(child, visit);
        } else {
          walkCandidateValue(value, visit);
        }
      }
    };
    const reachesCandidateValue = (node, activeVariables = new Set()) => {
      let reaches = false;
      walkCandidateValue(node, (candidate) => {
        if (reaches) return;
        if (
          candidate.type === "CallExpression" &&
          candidate.callee.type === "Identifier"
        ) {
          if (graphNames.has(candidate.callee.name)) {
            reaches = true;
            return;
          }
        }
        if (
          candidate.type === "CallExpression" &&
          isSafeTextMethodCall(candidate) &&
          candidate.arguments.some(
            (argument) =>
              argument.type === "Identifier" && graphNames.has(argument.name)
          )
        ) {
          reaches = true;
          return;
        }
        if (candidate.type === "Identifier") {
          const declaration = resolveVariable(candidate);
          if (declaration !== undefined && !activeVariables.has(declaration)) {
            const nextActive = new Set(activeVariables).add(declaration);
            const sources = [
              ...(declaration.init === null ? [] : [declaration.init]),
              ...(assignmentsByDeclaration.get(declaration) ?? []).map(
                (assignment) => assignment.right
              ),
            ];
            if (
              sources.some((source) =>
                reachesCandidateValue(source, nextActive)
              )
            ) {
              reaches = true;
            }
          }
        }
      });
      return reaches;
    };
    let closedSink = false;
    walkAst(program, (node) => {
      if (closedSink || node.type !== "CallExpression") return;
      const enclosingFunction = getEnclosingTopLevelFunction(node);
      const enclosingGraph =
        enclosingFunction === undefined
          ? undefined
          : analyzeFunction(enclosingFunction);
      const argumentReachesCandidate = node.arguments.some((argument) => {
        let reaches = reachesCandidateValue(argument);
        walkCandidateValue(argument, (candidate) => {
          if (
            reaches ||
            candidate.type !== "CallExpression" ||
            candidate.callee.type !== "Identifier"
          ) {
            return;
          }
          const target = resolveFunction(candidate.callee.name);
          if (
            target !== undefined &&
            analyzeFunction(target).functions.has(functionNode)
          ) {
            reaches = true;
          }
        });
        return reaches;
      });
      const reachesCandidate =
        enclosingGraph?.functions.has(functionNode) === true ||
        argumentReachesCandidate;
      if (getMemberCallName(node) === "test" && reachesCandidate) {
        closedSink = true;
        return;
      }
      if (isCanonicalSchemaMakeCall(node) && reachesCandidate) {
        closedSink = true;
      }
    });
    if (!closedSink) {
      return false;
    }
    let operationalEscape = false;
    const resolveObjectInput = (node, active = new Set()) => {
      if (node?.type === "ObjectExpression") return node;
      if (node?.type !== "Identifier") return undefined;
      const declaration = resolveVariable(node);
      if (declaration === undefined || active.has(declaration)) {
        return undefined;
      }
      const sources = [
        ...(declaration.init === null ? [] : [declaration.init]),
        ...(assignmentsByDeclaration.get(declaration) ?? []).map(
          (assignment) => assignment.right
        ),
      ];
      if (sources.length !== 1) return undefined;
      return resolveObjectInput(sources[0], new Set(active).add(declaration));
    };
    const hasOnlyOrdinaryTextFieldTaint = (node) => {
      const fields = getCanonicalSchemaMakeFields(node);
      const input = resolveObjectInput(node.arguments[0]);
      if (fields === undefined || input === undefined) {
        return false;
      }
      return input.properties.every((property) => {
        if (property.type !== "Property") {
          return !reachesCandidateValue(property);
        }
        if (!reachesCandidateValue(property.value)) return true;
        const name = getStaticName(property.key);
        const field = name === undefined ? undefined : fields.get(name);
        return field !== undefined && isOrdinaryUnbrandedTextSchema(field);
      });
    };
    const isOrdinaryTextField = (call, property) => {
      const fields = getCanonicalSchemaMakeFields(call);
      const name = getStaticName(property.key);
      const field = name === undefined ? undefined : fields?.get(name);
      return field !== undefined && isOrdinaryUnbrandedTextSchema(field);
    };
    const containsAnyIdentifier = (node, names) => {
      let contains = false;
      walkCandidateValue(node, (candidate) => {
        if (
          candidate.type === "Identifier" &&
          names.has(candidate.name) &&
          !isStaticPropertyIdentifier(candidate)
        ) {
          contains = true;
        }
      });
      return contains;
    };
    const isSchemaProjectionValue = (node, parameterNames) => {
      if (!containsAnyIdentifier(node, parameterNames)) return true;
      if (isCanonicalSchemaMakeCall(node)) {
        const input = node.arguments[0];
        if (input?.type !== "ObjectExpression") return false;
        return input.properties.every(
          (property) =>
            property.type === "Property" &&
            (!containsAnyIdentifier(property.value, parameterNames) ||
              isOrdinaryTextField(node, property))
        );
      }
      if (node.type === "ArrayExpression") {
        return node.elements.every(
          (element) =>
            element === null || isSchemaProjectionValue(element, parameterNames)
        );
      }
      if (
        node.type === "ConditionalExpression" ||
        node.type === "LogicalExpression"
      ) {
        return Object.values(node)
          .flatMap((value) =>
            Array.isArray(value)
              ? value
              : value?.type !== undefined
                ? [value]
                : []
          )
          .filter((value) => value !== node)
          .every((value) => isSchemaProjectionValue(value, parameterNames));
      }
      return false;
    };
    const isSanitizingSchemaProjectionCall = (node) => {
      if (
        (getMemberCallName(node) !== "map" &&
          getMemberCallName(node) !== "flatMap") ||
        node.arguments.length !== 1
      ) {
        return false;
      }
      const callback = node.arguments[0];
      if (
        callback?.type !== "ArrowFunctionExpression" &&
        callback?.type !== "FunctionExpression"
      ) {
        return false;
      }
      const parameterNames = new Set(
        callback.params
          .filter((parameter) => parameter.type === "Identifier")
          .map((parameter) => parameter.name)
      );
      if (parameterNames.size === 0) return false;
      const returns =
        callback.body.type === "BlockStatement" ? [] : [callback.body];
      if (callback.body.type === "BlockStatement") {
        walkAst(callback.body, (candidate) => {
          if (
            candidate.type === "ReturnStatement" &&
            candidate.argument !== null &&
            findEnclosingFunction(candidate) === callback
          ) {
            returns.push(candidate.argument);
          }
        });
      }
      if (
        returns.length === 0 ||
        !returns.every((value) =>
          isSchemaProjectionValue(value, parameterNames)
        )
      ) {
        return false;
      }
      let closedReferences = true;
      walkAst(callback.body, (candidate) => {
        if (
          !closedReferences ||
          candidate.type !== "Identifier" ||
          !parameterNames.has(candidate.name) ||
          isStaticPropertyIdentifier(candidate)
        ) {
          return;
        }
        if (findEnclosingFunction(candidate) !== callback) {
          closedReferences = false;
          return;
        }
        closedReferences = returns.some((value) => {
          let current = candidate;
          while (current !== undefined && current !== null) {
            if (current === value) return true;
            if (current === callback.body) break;
            current = current.parent;
          }
          return false;
        });
      });
      return closedReferences;
    };
    const getVariableReferences = (declaration) => {
      const references = [];
      const scope = findEnclosingFunction(declaration) ?? program;
      const bindingNodes = new Set(bindings.get(declaration.id.name));
      walkAst(scope, (node) => {
        if (
          node.type !== "Identifier" ||
          node === declaration.id ||
          bindingNodes.has(node) ||
          node.name !== declaration.id.name ||
          isStaticPropertyIdentifier(node) ||
          (node.parent?.type === "AssignmentExpression" &&
            node.parent.left === node &&
            node.parent.operator === "=")
        ) {
          return;
        }
        const resolved = resolveVariable(node);
        if (resolved === declaration || resolved === undefined) {
          references.push(node);
        }
      });
      return references;
    };
    const isClosedCallbackCapture = (reference, declarationScope) => {
      let callable = findEnclosingFunction(reference);
      while (callable !== undefined && callable !== declarationScope) {
        const call = callable.parent;
        if (
          call?.type !== "CallExpression" ||
          !call.arguments.includes(callable) ||
          !isSafeTextMethodCall(call) ||
          !isClosedReceiver(call.callee.object)
        ) {
          return false;
        }
        callable = findEnclosingFunction(call);
      }
      return callable === declarationScope;
    };
    const getFunctionNames = (target) =>
      [
        target.id?.name,
        ...[...functionAliases.entries()]
          .filter(([, functionNode]) => functionNode === target)
          .map(([name]) => name),
      ].filter(Boolean);
    const isDirectCandidateProducer = (node) => {
      if (node.callee.type === "Identifier") {
        const target = resolveFunction(node.callee.name);
        return (
          target === functionNode ||
          (target !== undefined &&
            analysis.functions.has(target) &&
            analyzeFunction(target).functions.has(functionNode))
        );
      }
      return (
        isSafeTextMethodCall(node) &&
        node.arguments.some(
          (argument) =>
            argument.type === "Identifier" && graphNames.has(argument.name)
        )
      );
    };
    const mutatingTextMethodNames = new Set(["add", "push"]);
    const stateKey = (kind, node) => `${kind}:${node.start}:${node.end}`;
    const traceUse = (node, active = new Set()) => {
      const key = stateKey("value", node);
      if (active.has(key)) return true;
      const nextActive = new Set(active).add(key);
      const parent = node.parent;
      if (parent === undefined || parent === null) return false;

      if (transparentCallableWrappers.has(parent.type)) {
        return traceUse(parent, nextActive);
      }
      if (parent.type === "VariableDeclarator" && parent.init === node) {
        if (parent.id.type !== "Identifier") return false;
        const bindingKey = stateKey("binding", parent);
        if (nextActive.has(bindingKey)) return true;
        const references = getVariableReferences(parent);
        if (references.length === 0) return false;
        const bindingState = new Set(nextActive).add(bindingKey);
        const declarationScope = findEnclosingFunction(parent);
        return references.every((reference) => {
          if (
            findEnclosingFunction(reference) !== declarationScope &&
            !isClosedCallbackCapture(reference, declarationScope)
          ) {
            return false;
          }
          return traceUse(reference, bindingState);
        });
      }
      if (parent.type === "AssignmentExpression") {
        if (parent.right === node) {
          if (parent.left.type !== "Identifier") {
            return false;
          }
          const declaration = resolveVariable(parent.left);
          if (declaration === undefined) {
            return false;
          }
          const bindingKey = stateKey("binding", declaration);
          if (nextActive.has(bindingKey)) return true;
          const references = getVariableReferences(declaration);
          if (references.length === 0) return false;
          const bindingState = new Set(nextActive).add(bindingKey);
          const declarationScope = findEnclosingFunction(declaration);
          return references.every((reference) => {
            if (
              findEnclosingFunction(reference) !== declarationScope &&
              !isClosedCallbackCapture(reference, declarationScope)
            ) {
              return false;
            }
            return traceUse(reference, bindingState);
          });
        }
        return parent.operator !== "=" && parent.left === node;
      }
      if (parent.type === "MemberExpression") {
        if (parent.object !== node) {
          return parent.computed && parent.property === node
            ? traceUse(parent, nextActive)
            : false;
        }
        if (
          (parent.parent?.type === "AssignmentExpression" &&
            parent.parent.left === parent) ||
          (parent.parent?.type === "UpdateExpression" &&
            parent.parent.argument === parent) ||
          (parent.parent?.type === "UnaryExpression" &&
            parent.parent.operator === "delete")
        ) {
          return false;
        }
        return traceUse(parent, nextActive);
      }
      if (parent.type === "Property" && parent.value === node) {
        const object = parent.parent;
        const call = object?.parent;
        if (
          object?.type === "ObjectExpression" &&
          call?.type === "CallExpression" &&
          call.arguments.includes(object) &&
          isCanonicalSchemaMakeCall(call)
        ) {
          return isOrdinaryTextField(call, parent);
        }
        return object?.type === "ObjectExpression"
          ? traceUse(object, nextActive)
          : false;
      }
      if (
        parent.type === "ArrayExpression" ||
        parent.type === "ObjectExpression" ||
        parent.type === "SpreadElement" ||
        parent.type === "TemplateLiteral" ||
        parent.type === "TaggedTemplateExpression"
      ) {
        return traceUse(parent, nextActive);
      }
      if (
        parent.type === "NewExpression" &&
        parent.arguments.includes(node) &&
        parent.callee.type === "Identifier" &&
        (parent.callee.name === "Set" || parent.callee.name === "RegExp") &&
        !hasCounterfeitGlobalBinding(parent, parent.callee.name)
      ) {
        return traceUse(parent, nextActive);
      }
      if (
        parent.type === "ArrowFunctionExpression" &&
        parent.body === node &&
        parent.parent?.type === "CallExpression" &&
        parent.parent.arguments.includes(parent) &&
        isSafeTextMethodCall(parent.parent) &&
        isClosedReceiver(parent.parent.callee.object)
      ) {
        return traceUse(parent.parent, nextActive);
      }
      if (parent.type === "ReturnStatement" && parent.argument === node) {
        const owner = findEnclosingFunction(parent);
        if (owner === undefined) return false;
        if (
          (owner.type === "ArrowFunctionExpression" ||
            owner.type === "FunctionExpression") &&
          owner.parent?.type === "CallExpression" &&
          owner.parent.arguments.includes(owner) &&
          isSafeTextMethodCall(owner.parent) &&
          isClosedReceiver(owner.parent.callee.object)
        ) {
          return traceUse(owner.parent, nextActive);
        }
        if (owner.type !== "FunctionDeclaration") {
          return false;
        }
        const returnKey = stateKey("return", owner);
        if (nextActive.has(returnKey)) return true;
        const returnState = new Set(nextActive).add(returnKey);
        const references = getFunctionNames(owner).flatMap((name) =>
          getValueReferences(program, name, bindings)
        );
        const calls = references.flatMap((reference) => {
          if (
            reference.parent?.type === "VariableDeclarator" &&
            reference.parent.init === reference &&
            functionAliases.has(reference.parent.id?.name)
          ) {
            return [];
          }
          const call = reference.parent;
          return call?.type === "CallExpression" &&
            (call.callee === reference ||
              (call.arguments.includes(reference) &&
                isSafeTextMethodCall(call) &&
                isClosedReceiver(call.callee.object)))
            ? [call]
            : [undefined];
        });
        return (
          calls.length > 0 &&
          calls.every(
            (call) => call !== undefined && traceUse(call, returnState)
          )
        );
      }
      if (parent.type === "CallExpression") {
        if (isSanitizingSchemaProjectionCall(parent)) {
          return true;
        }
        if (
          getMemberCallName(parent) === "test" &&
          isClosedReceiver(parent.callee.object)
        ) {
          return true;
        }
        if (isCanonicalSchemaMakeCall(parent)) {
          return hasOnlyOrdinaryTextFieldTaint(parent);
        }
        if (
          isSafeTextMethodCall(parent) &&
          isClosedReceiver(parent.callee.object)
        ) {
          const methodName = getMemberCallName(parent);
          if (
            methodName !== undefined &&
            mutatingTextMethodNames.has(methodName) &&
            parent.arguments.some(
              (argument) => argument === node || reachesCandidateValue(argument)
            )
          ) {
            const receiver = parent.callee.object;
            if (receiver.type !== "Identifier") return false;
            const declaration = resolveVariable(receiver);
            if (declaration === undefined) return false;
            const references = getVariableReferences(declaration).filter(
              (reference) => {
                let current = reference;
                while (current !== undefined && current !== null) {
                  if (current === parent) return false;
                  if (current === program) break;
                  current = current.parent;
                }
                return true;
              }
            );
            return (
              references.length > 0 &&
              references.every((reference) => traceUse(reference, nextActive))
            );
          }
          return traceUse(parent, nextActive);
        }
        if (parent.callee.type === "Identifier") {
          const target = resolveFunction(parent.callee.name);
          if (target === undefined) return false;
          const taintedIndexes = parent.arguments.flatMap((argument, index) =>
            argument === node || reachesCandidateValue(argument) ? [index] : []
          );
          if (taintedIndexes.length === 0) {
            return traceUse(parent, nextActive);
          }
          return taintedIndexes.every((index) => {
            const parameter = target.params[index];
            if (parameter?.type !== "Identifier") return false;
            const parameterKey = stateKey("parameter", parameter);
            if (nextActive.has(parameterKey)) return true;
            const parameterState = new Set(nextActive).add(parameterKey);
            const references = [];
            walkAst(target.body, (candidate) => {
              if (
                candidate.type === "Identifier" &&
                candidate.name === parameter.name &&
                !isStaticPropertyIdentifier(candidate) &&
                candidate.parent?.type !== "TSTypePredicate"
              ) {
                references.push(candidate);
              }
            });
            return (
              references.length > 0 &&
              references.every(
                (reference) =>
                  (findEnclosingFunction(reference) === target ||
                    isClosedCallbackCapture(reference, target)) &&
                  traceUse(reference, parameterState)
              )
            );
          });
        }
        return false;
      }
      if (
        parent.type === "BinaryExpression" ||
        parent.type === "ConditionalExpression" ||
        parent.type === "LogicalExpression" ||
        parent.type === "SequenceExpression"
      ) {
        return traceUse(parent, nextActive);
      }
      if (parent.type === "UnaryExpression") {
        return parent.operator !== "void" && parent.operator !== "delete"
          ? traceUse(parent, nextActive)
          : false;
      }
      if (
        (parent.type === "IfStatement" && parent.test === node) ||
        (parent.type === "WhileStatement" && parent.test === node) ||
        (parent.type === "DoWhileStatement" && parent.test === node) ||
        (parent.type === "ForStatement" && parent.test === node) ||
        (parent.type === "SwitchStatement" && parent.discriminant === node)
      ) {
        return true;
      }
      if (parent.type === "ForOfStatement" && parent.right === node) {
        if (
          parent.left.type !== "VariableDeclaration" ||
          parent.left.declarations.length !== 1 ||
          parent.left.declarations[0].id.type !== "Identifier"
        ) {
          return false;
        }
        const declaration = parent.left.declarations[0];
        const references = getVariableReferences(declaration);
        return (
          references.length > 0 &&
          references.every((reference) => traceUse(reference, nextActive))
        );
      }
      return false;
    };
    let closedValueUses = true;
    let producerCount = 0;
    walkAst(program, (node) => {
      if (
        !closedValueUses ||
        node.type !== "CallExpression" ||
        !isDirectCandidateProducer(node)
      ) {
        return;
      }
      const enclosingFunction = getEnclosingTopLevelFunction(node);
      if (
        enclosingFunction !== undefined &&
        analysis.functions.has(enclosingFunction)
      ) {
        return;
      }
      producerCount += 1;
      if (!traceUse(node)) {
        closedValueUses = false;
      }
    });
    walkAst(program, (node) => {
      if (operationalEscape || node.type !== "CallExpression") return;
      const taintedArguments = node.arguments.filter((argument) =>
        reachesCandidateValue(argument)
      );
      if (taintedArguments.length === 0) return;
      if (isSafeTextMethodCall(node) && isClosedReceiver(node.callee.object)) {
        return;
      }
      if (
        node.callee.type === "Identifier" &&
        resolveFunction(node.callee.name) !== undefined
      ) {
        const target = resolveFunction(node.callee.name);
        const targetAnalysis = analyzeFunction(target);
        if (targetAnalysis.safe || targetAnalysis.functions.has(functionNode)) {
          return;
        }
      }
      if (
        isCanonicalSchemaMakeCall(node) &&
        hasOnlyOrdinaryTextFieldTaint(node)
      ) {
        return;
      }
      operationalEscape = true;
    });
    return producerCount > 0 && closedValueUses && !operationalEscape;
  };

  return { isClosed };
};

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
    const classDeclarations = new Map();
    const importedTypeBindingCounts = new Map();
    const typeDeclarations = new Map();
    const typeReferences = [];
    let hasCanonicalSchemaBinding = false;
    const rememberTypeDeclaration = (node) => {
      const name = getStaticName(node.id);
      if (name === undefined) return;
      const declarations = typeDeclarations.get(name) ?? [];
      declarations.push(node);
      typeDeclarations.set(name, declarations);
    };
    const reportDeclaration = (node, members) => {
      if (
        !isAllCallable(members) &&
        !isFrameworkProps(context, node, members)
      ) {
        context.report({ messageId: "schemaFirst", node: node.id ?? node });
      }
    };

    return {
      Program(node) {
        hasCanonicalSchemaBinding = hasUniqueCanonicalEffectSchemaBinding(node);
        for (const statement of node.body) {
          if (statement.type === "ImportDeclaration") {
            for (const specifier of statement.specifiers) {
              importedTypeBindingCounts.set(
                specifier.local.name,
                (importedTypeBindingCounts.get(specifier.local.name) ?? 0) + 1
              );
            }
          }
          const declaration = unwrapProgramDeclaration(statement);
          if (
            declaration?.type === "TSInterfaceDeclaration" ||
            declaration?.type === "TSTypeAliasDeclaration"
          ) {
            rememberTypeDeclaration(declaration);
          } else if (
            declaration?.type === "ClassDeclaration" &&
            declaration.id?.type === "Identifier"
          ) {
            const candidates = classDeclarations.get(declaration.id.name) ?? [];
            candidates.push(declaration);
            classDeclarations.set(declaration.id.name, candidates);
          }
        }
      },
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
                !isCapabilityWrapperAlias(
                  node,
                  typeDeclarations,
                  classDeclarations,
                  importedTypeBindingCounts,
                  context.sourceCode.isGlobalReference,
                  hasCanonicalSchemaBinding
                ) &&
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
        if (
          !isCapabilityWrapperAlias(
            node,
            typeDeclarations,
            classDeclarations,
            importedTypeBindingCounts,
            context.sourceCode.isGlobalReference,
            hasCanonicalSchemaBinding
          )
        ) {
          reportDeclaration(node, node.typeAnnotation.members);
        }
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
    let program;
    const rawParameterCandidates = [];
    const report = (node, name) => {
      context.report({
        data: { name },
        messageId: "unbrandedDomainString",
        node,
      });
    };

    return {
      Program(node) {
        program = node;
      },
      "Program:exit"() {
        if (program === undefined) return;
        const bindings = collectBindingIdentifiers(program);
        for (const candidate of rawParameterCandidates) {
          const textGraph = createClosedTextGraph(program, bindings);
          if (
            !isCanonicalSchemaRefinement(
              program,
              candidate.functionNode,
              candidate.node,
              bindings
            ) &&
            !textGraph.isClosed(candidate.functionNode, candidate.node)
          ) {
            report(candidate.node, candidate.name);
          }
        }
      },
      Identifier(node) {
        const functionNode = findDirectEnclosingFunction(node);
        if (!isStringTypeAnnotation(node) || functionNode === undefined) {
          return;
        }
        const semanticName = getParameterSemanticName(node, node.name);
        if (
          !isRawParserParameter(node, node.name) &&
          !isProviderRawParameter(context, node, node.name) &&
          (isSemanticName(semanticName) ||
            isRawCallableParameter(node, node.name))
        ) {
          if (
            rawParameterNames.has(node.name) &&
            functionNode.type === "FunctionDeclaration"
          ) {
            rawParameterCandidates.push({
              functionNode,
              name: semanticName,
              node,
            });
          } else {
            report(node, semanticName);
          }
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
