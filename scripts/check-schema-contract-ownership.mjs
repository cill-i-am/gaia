import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const anchorFileName = "__gaia_schema_contract_anchor.ts";
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const anchorSource = `
  import { Schema } from "effect";
  export type __GaiaSchemaTop = Schema.Top;
  export const __GaiaPlainSchema = Schema.String;
  export type __GaiaPlainType = typeof __GaiaPlainSchema.Type;
  export const __GaiaBrandedSchema = Schema.String.pipe(
    Schema.brand("__GaiaBrandAnchor")
  );
  export type __GaiaBrandedType = typeof __GaiaBrandedSchema.Type;
  export const __GaiaPipedSchema = __GaiaPlainSchema.pipe(
    Schema.brand("__GaiaPipeAnchor")
  );
  export type __GaiaCanonicalSchemaType =
    Schema.Schema.Type<typeof __GaiaBrandedSchema>;
  export type __GaiaCanonicalPick = Pick<__GaiaBrandedType, never>;
  export type __GaiaCanonicalOmit = Omit<__GaiaBrandedType, never>;
  export type __GaiaCanonicalExtract = Extract<
    __GaiaBrandedType,
    __GaiaBrandedType
  >;
`;

const schemaFirstRemedy =
  "Define the owning Effect Schema and derive this contract from its decoded Type.";
const brandCastRemedy =
  "Decode with the owning Effect Schema or parser and carry its branded result inward.";
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
]);
const frameworkTypeNames = new Set(["Element", "ReactElement", "ReactNode"]);

const resolveAlias = (checker, symbol) => {
  let current = symbol;
  const seen = new Set();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
};

const getValueTypeForEntityName = (checker, entityName) => {
  const symbol = checker.getSymbolAtLocation(entityName);
  if (symbol === undefined) return undefined;
  const resolved = resolveAlias(checker, symbol);
  const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
  return declaration === undefined
    ? undefined
    : checker.getTypeOfSymbolAtLocation(resolved, declaration);
};

const getValueSymbolForEntityName = (checker, entityName) => {
  const symbol = checker.getSymbolAtLocation(entityName);
  return symbol === undefined ? undefined : resolveAlias(checker, symbol);
};

const isAllCallable = (members) =>
  members.length > 0 &&
  members.every((member) => {
    if (
      ts.isCallSignatureDeclaration(member) ||
      ts.isConstructSignatureDeclaration(member) ||
      ts.isMethodSignature(member)
    ) {
      return true;
    }
    return (
      ts.isPropertySignature(member) &&
      member.type !== undefined &&
      ts.isFunctionTypeNode(member.type)
    );
  });

const getPropertyName = (name) => {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
};

const isFrameworkTypeNode = (node) => {
  if (!ts.isTypeReferenceNode(node)) return false;
  if (ts.isIdentifier(node.typeName)) {
    return frameworkTypeNames.has(node.typeName.text);
  }
  return (
    ts.isQualifiedName(node.typeName) &&
    frameworkTypeNames.has(node.typeName.right.text)
  );
};

const getSchemaTopType = (checker, anchorFile) => {
  const declaration = anchorFile.statements.find(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "__GaiaSchemaTop"
  );
  if (declaration === undefined || !ts.isTypeAliasDeclaration(declaration)) {
    throw new Error(
      "Gaia schema-contract checker could not resolve Schema.Top"
    );
  }
  return checker.getTypeFromTypeNode(declaration.type);
};

const getAnchorType = (checker, anchorFile, name) => {
  const declaration = anchorFile.statements.find(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name
  );
  if (declaration === undefined || !ts.isTypeAliasDeclaration(declaration)) {
    throw new Error(`Gaia schema-contract checker could not resolve ${name}`);
  }
  return checker.getTypeFromTypeNode(declaration.type);
};

const getAnchorTypeDeclaration = (anchorFile, name) => {
  const declaration = anchorFile.statements.find(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name
  );
  if (declaration === undefined || !ts.isTypeAliasDeclaration(declaration)) {
    throw new Error(`Gaia schema-contract checker could not resolve ${name}`);
  }
  return declaration;
};

const getCanonicalDecodedTypeProperty = (checker, anchorFile) => {
  const declaration = getAnchorTypeDeclaration(anchorFile, "__GaiaPlainType");
  if (
    !ts.isTypeQueryNode(declaration.type) ||
    !ts.isQualifiedName(declaration.type.exprName)
  ) {
    throw new Error(
      "Gaia schema-contract checker could not resolve Schema decoded Type property"
    );
  }
  const symbol = checker.getSymbolAtLocation(declaration.type.exprName.right);
  if (symbol === undefined || (symbol.declarations?.length ?? 0) === 0) {
    throw new Error(
      "Gaia schema-contract checker could not prove Schema decoded Type property provenance"
    );
  }
  return {
    declarationFiles: new Set(
      symbol.declarations.map((declaration) => declaration.getSourceFile())
    ),
    escapedName: symbol.escapedName,
  };
};

const getCanonicalProjectionSymbols = (checker, anchorFile) => {
  const symbols = new Set();
  for (const name of [
    "__GaiaCanonicalExtract",
    "__GaiaCanonicalOmit",
    "__GaiaCanonicalPick",
  ]) {
    const declaration = getAnchorTypeDeclaration(anchorFile, name);
    if (!ts.isTypeReferenceNode(declaration.type)) {
      throw new Error(
        `Gaia schema-contract checker could not resolve canonical projection ${name}`
      );
    }
    const symbol = checker.getSymbolAtLocation(declaration.type.typeName);
    if (symbol === undefined) {
      throw new Error(
        `Gaia schema-contract checker could not prove canonical projection ${name}`
      );
    }
    symbols.add(resolveAlias(checker, symbol));
  }
  return symbols;
};

const getCanonicalSchemaDeclarationFiles = (checker, anchorFile) => {
  const declaration = getAnchorTypeDeclaration(anchorFile, "__GaiaSchemaTop");
  if (!ts.isTypeReferenceNode(declaration.type)) {
    throw new Error(
      "Gaia schema-contract checker could not resolve canonical Schema declarations"
    );
  }
  const symbol = checker.getSymbolAtLocation(declaration.type.typeName);
  if (symbol === undefined) {
    throw new Error(
      "Gaia schema-contract checker could not prove canonical Schema declarations"
    );
  }
  return new Set(
    (resolveAlias(checker, symbol).declarations ?? []).map((candidate) =>
      candidate.getSourceFile()
    )
  );
};

const getCanonicalSchemaTypeSymbol = (checker, anchorFile) => {
  const declaration = getAnchorTypeDeclaration(
    anchorFile,
    "__GaiaCanonicalSchemaType"
  );
  if (!ts.isTypeReferenceNode(declaration.type)) {
    throw new Error(
      "Gaia schema-contract checker could not resolve Schema.Schema.Type"
    );
  }
  const symbol = checker.getSymbolAtLocation(declaration.type.typeName);
  if (symbol === undefined) {
    throw new Error(
      "Gaia schema-contract checker could not prove Schema.Schema.Type provenance"
    );
  }
  return resolveAlias(checker, symbol);
};

const getCanonicalSchemaPipeSymbol = (checker, anchorFile) => {
  const declaration = anchorFile.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (candidate) =>
          candidate.name.getText(anchorFile) === "__GaiaPipedSchema"
      )
  );
  const variable =
    declaration !== undefined && ts.isVariableStatement(declaration)
      ? declaration.declarationList.declarations.find(
          (candidate) =>
            candidate.name.getText(anchorFile) === "__GaiaPipedSchema"
        )
      : undefined;
  if (
    variable?.initializer === undefined ||
    !ts.isCallExpression(variable.initializer) ||
    !ts.isPropertyAccessExpression(variable.initializer.expression)
  ) {
    throw new Error(
      "Gaia schema-contract checker could not resolve Schema pipe composition"
    );
  }
  const symbol = checker.getSymbolAtLocation(
    variable.initializer.expression.name
  );
  if (symbol === undefined) {
    throw new Error(
      "Gaia schema-contract checker could not prove Schema pipe composition"
    );
  }
  return resolveAlias(checker, symbol);
};

const createSchemaProof = (checker, anchorFile) => ({
  canonicalDecodedTypeProperty: getCanonicalDecodedTypeProperty(
    checker,
    anchorFile
  ),
  canonicalProjectionSymbols: getCanonicalProjectionSymbols(
    checker,
    anchorFile
  ),
  canonicalSchemaDeclarationFiles: getCanonicalSchemaDeclarationFiles(
    checker,
    anchorFile
  ),
  canonicalSchemaPipeSymbol: getCanonicalSchemaPipeSymbol(checker, anchorFile),
  canonicalSchemaTypeSymbol: getCanonicalSchemaTypeSymbol(checker, anchorFile),
  schemaTopType: getSchemaTopType(checker, anchorFile),
});

const getCanonicalBrandMarker = (checker, anchorFile) => {
  const plainType = getAnchorType(checker, anchorFile, "__GaiaPlainType");
  const brandedType = getAnchorType(checker, anchorFile, "__GaiaBrandedType");
  const plainPropertyNames = new Set(
    checker
      .getPropertiesOfType(plainType)
      .map((property) => property.escapedName)
  );
  const candidates = checker
    .getPropertiesOfType(brandedType)
    .filter(
      (property) =>
        !plainPropertyNames.has(property.escapedName) &&
        (property.declarations?.length ?? 0) > 0
    );

  if (candidates.length !== 1) {
    throw new Error(
      `Gaia schema-contract checker expected one canonical Effect Brand marker, found ${candidates.length}`
    );
  }

  return {
    declarations: new Set(candidates[0].declarations),
    escapedName: candidates[0].escapedName,
  };
};

const hasCanonicalBrandMarker = (checker, type, marker) => {
  const property = checker.getPropertyOfType(type, marker.escapedName);
  if (property === undefined) return false;
  return (
    property.declarations?.some((declaration) =>
      marker.declarations.has(declaration)
    ) === true
  );
};

const containsCanonicalBrandMarker = (
  checker,
  type,
  marker,
  seenTypes = new Set()
) => {
  if (seenTypes.has(type)) return false;
  seenTypes.add(type);
  if (hasCanonicalBrandMarker(checker, type, marker)) return true;

  if (type.isUnionOrIntersection()) {
    return type.types.some((member) =>
      containsCanonicalBrandMarker(checker, member, marker, seenTypes)
    );
  }

  const isCallableType =
    type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0;
  if (!isCallableType) {
    const typeArguments = [
      ...(type.aliasTypeArguments ?? []),
      ...((type.flags & ts.TypeFlags.Object) !== 0 &&
      (type.objectFlags & ts.ObjectFlags.Reference) !== 0
        ? checker.getTypeArguments(type)
        : []),
    ];
    if (
      typeArguments.some((argument) =>
        containsCanonicalBrandMarker(checker, argument, marker, seenTypes)
      )
    ) {
      return true;
    }
  }

  for (const indexInfo of checker.getIndexInfosOfType(type)) {
    if (
      containsCanonicalBrandMarker(checker, indexInfo.type, marker, seenTypes)
    ) {
      return true;
    }
  }

  if (
    (type.flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.ESSymbolLike |
        ts.TypeFlags.Never |
        ts.TypeFlags.Null |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.StringLike |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.Void)) !==
    0
  ) {
    return false;
  }

  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (declaration === undefined) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(
      property,
      declaration
    );
    if (
      propertyType.getCallSignatures().length > 0 ||
      propertyType.getConstructSignatures().length > 0
    ) {
      continue;
    }
    if (
      containsCanonicalBrandMarker(checker, propertyType, marker, seenTypes)
    ) {
      return true;
    }
  }

  return false;
};

const isSchemaValueType = (checker, proof, valueType) => {
  if (!checker.isTypeAssignableTo(valueType, proof.schemaTopType)) return false;
  const decodedProperty = checker.getPropertyOfType(
    valueType,
    proof.canonicalDecodedTypeProperty.escapedName
  );
  return (
    decodedProperty?.declarations?.some((declaration) =>
      proof.canonicalDecodedTypeProperty.declarationFiles.has(
        declaration.getSourceFile()
      )
    ) === true
  );
};

const hasCanonicalSchemaDeclaration = (checker, proof, symbol) =>
  (resolveAlias(checker, symbol).declarations ?? []).some((declaration) =>
    proof.canonicalSchemaDeclarationFiles.has(declaration.getSourceFile())
  );

const isCanonicalSchemaApiCall = (
  checker,
  proof,
  node,
  seenSymbols = new Set()
) => {
  const calleeSymbol = checker.getSymbolAtLocation(node.expression);
  if (
    calleeSymbol !== undefined &&
    hasCanonicalSchemaDeclaration(checker, proof, calleeSymbol)
  ) {
    if (ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const receiverType = checker.getTypeAtLocation(receiver);
      if (
        isSchemaValueType(checker, proof, receiverType) &&
        !isCanonicalSchemaValueExpression(checker, proof, receiver, seenSymbols)
      ) {
        return false;
      }
    }
    return true;
  }
  if (
    !ts.isCallExpression(node.expression) ||
    !isCanonicalSchemaApiCall(checker, proof, node.expression, seenSymbols)
  ) {
    return false;
  }
  return node.arguments.every((argument) => {
    const argumentType = checker.getTypeAtLocation(argument);
    return (
      !isSchemaValueType(checker, proof, argumentType) ||
      isCanonicalSchemaValueExpression(checker, proof, argument, seenSymbols)
    );
  });
};

const isCanonicalSchemaValueSymbol = (
  checker,
  proof,
  symbol,
  seenSymbols = new Set()
) => {
  const resolved = resolveAlias(checker, symbol);
  if (seenSymbols.has(resolved)) return false;
  seenSymbols.add(resolved);

  if (hasCanonicalSchemaDeclaration(checker, proof, resolved)) return true;

  for (const declaration of resolved.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      isCanonicalSchemaValueExpression(
        checker,
        proof,
        declaration.initializer,
        seenSymbols
      )
    ) {
      return true;
    }
    if (
      ts.isClassDeclaration(declaration) &&
      declaration.heritageClauses?.some((clause) =>
        clause.types.some(
          (heritage) =>
            ts.isCallExpression(heritage.expression) &&
            isCanonicalSchemaApiCall(
              checker,
              proof,
              heritage.expression,
              seenSymbols
            )
        )
      ) === true
    ) {
      return true;
    }
  }
  return false;
};

function isCanonicalSchemaValueExpression(
  checker,
  proof,
  node,
  seenSymbols = new Set()
) {
  const valueType = checker.getTypeAtLocation(node);
  if (!isSchemaValueType(checker, proof, valueType)) return false;

  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    return (
      symbol !== undefined &&
      isCanonicalSchemaValueSymbol(checker, proof, symbol, seenSymbols)
    );
  }

  if (!ts.isCallExpression(node)) return false;
  if (isCanonicalSchemaApiCall(checker, proof, node, seenSymbols)) return true;
  if (!ts.isPropertyAccessExpression(node.expression)) return false;

  const methodSymbol = checker.getSymbolAtLocation(node.expression.name);
  if (
    methodSymbol === undefined ||
    resolveAlias(checker, methodSymbol) !== proof.canonicalSchemaPipeSymbol ||
    !isCanonicalSchemaValueExpression(
      checker,
      proof,
      node.expression.expression,
      seenSymbols
    )
  ) {
    return false;
  }
  return node.arguments.every(
    (argument) =>
      ts.isCallExpression(argument) &&
      isCanonicalSchemaApiCall(checker, proof, argument, seenSymbols)
  );
}

const isSchemaValueEntity = (checker, proof, entityName) => {
  const symbol = getValueSymbolForEntityName(checker, entityName);
  const valueType = getValueTypeForEntityName(checker, entityName);
  return (
    symbol !== undefined &&
    valueType !== undefined &&
    isSchemaValueType(checker, proof, valueType) &&
    isCanonicalSchemaValueSymbol(checker, proof, symbol)
  );
};

const isCanonicalProjectionTypeNode = (checker, proof, node) => {
  if (!ts.isTypeReferenceNode(node) || node.typeArguments?.[0] === undefined) {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(node.typeName);
  return (
    symbol !== undefined &&
    proof.canonicalProjectionSymbols.has(resolveAlias(checker, symbol))
  );
};

const isCanonicalSchemaTypeProjectionCandidate = (checker, proof, node) => {
  if (!ts.isTypeReferenceNode(node)) return false;
  const symbol = checker.getSymbolAtLocation(node.typeName);
  return (
    symbol !== undefined &&
    resolveAlias(checker, symbol) === proof.canonicalSchemaTypeSymbol
  );
};

const isCanonicalSchemaTypeProjection = (checker, proof, node) => {
  if (
    !isCanonicalSchemaTypeProjectionCandidate(checker, proof, node) ||
    node.typeArguments?.length !== 1 ||
    !ts.isTypeQueryNode(node.typeArguments[0])
  ) {
    return false;
  }
  return isSchemaValueEntity(checker, proof, node.typeArguments[0].exprName);
};

const isCanonicalDecodedTypeAccess = (checker, proof, node) => {
  if (ts.isTypeQueryNode(node) && ts.isQualifiedName(node.exprName)) {
    if (!isSchemaValueEntity(checker, proof, node.exprName.left)) return false;
    const propertySymbol = checker.getSymbolAtLocation(node.exprName.right);
    const schemaValueType = getValueTypeForEntityName(
      checker,
      node.exprName.left
    );
    if (
      schemaValueType === undefined ||
      !isSchemaValueType(checker, proof, schemaValueType)
    ) {
      return false;
    }
    const decodedProperty = checker.getPropertyOfType(
      schemaValueType,
      proof.canonicalDecodedTypeProperty.escapedName
    );
    return (
      decodedProperty !== undefined &&
      propertySymbol !== undefined &&
      propertySymbol.escapedName === decodedProperty.escapedName &&
      propertySymbol.declarations?.some((declaration) =>
        decodedProperty.declarations?.includes(declaration)
      ) === true
    );
  }

  if (
    !ts.isIndexedAccessTypeNode(node) ||
    !ts.isTypeQueryNode(node.objectType) ||
    !ts.isLiteralTypeNode(node.indexType) ||
    !ts.isStringLiteral(node.indexType.literal)
  ) {
    return false;
  }
  const schemaValueType = getValueTypeForEntityName(
    checker,
    node.objectType.exprName
  );
  if (
    !isSchemaValueEntity(checker, proof, node.objectType.exprName) ||
    schemaValueType === undefined ||
    !isSchemaValueType(checker, proof, schemaValueType)
  ) {
    return false;
  }
  const indexedProperty = checker.getPropertyOfType(
    schemaValueType,
    node.indexType.literal.text
  );
  const decodedProperty = checker.getPropertyOfType(
    schemaValueType,
    proof.canonicalDecodedTypeProperty.escapedName
  );
  return (
    indexedProperty !== undefined &&
    decodedProperty !== undefined &&
    indexedProperty.escapedName === decodedProperty.escapedName &&
    indexedProperty.declarations?.some((declaration) =>
      decodedProperty.declarations?.includes(declaration)
    ) === true
  );
};

const isSchemaDerivedTypeNode = (
  checker,
  proof,
  node,
  seenSymbols = new Set()
) => {
  if (ts.isParenthesizedTypeNode(node)) {
    return isSchemaDerivedTypeNode(checker, proof, node.type, seenSymbols);
  }

  if (ts.isTypeQueryNode(node) || ts.isIndexedAccessTypeNode(node)) {
    return isCanonicalDecodedTypeAccess(checker, proof, node);
  }

  if (ts.isTypeReferenceNode(node)) {
    if (isCanonicalSchemaTypeProjection(checker, proof, node)) return true;

    if (isCanonicalProjectionTypeNode(checker, proof, node)) {
      return isSchemaDerivedTypeNode(
        checker,
        proof,
        node.typeArguments[0],
        seenSymbols
      );
    }

    const symbol = checker.getSymbolAtLocation(node.typeName);
    if (symbol === undefined) return false;
    const resolved = resolveAlias(checker, symbol);
    if (seenSymbols.has(resolved)) return false;
    seenSymbols.add(resolved);

    for (const declaration of resolved.declarations ?? []) {
      if (
        ts.isTypeAliasDeclaration(declaration) &&
        isSchemaDerivedTypeNode(checker, proof, declaration.type, seenSymbols)
      ) {
        return true;
      }
      if (ts.isClassDeclaration(declaration)) {
        const classSymbol = checker.getSymbolAtLocation(declaration.name);
        if (
          classSymbol !== undefined &&
          isCanonicalSchemaValueSymbol(checker, proof, classSymbol)
        ) {
          return true;
        }
      }
    }
  }

  return false;
};

const isSchemaOwnerTypeArgument = (checker, proof, node) =>
  isSchemaDerivedTypeNode(checker, proof, node) ||
  (ts.isTypeQueryNode(node) &&
    isSchemaValueEntity(checker, proof, node.exprName));

const hasSchemaOwnerTypeArgument = (checker, proof, node) =>
  ts.isTypeReferenceNode(node) &&
  node.typeArguments?.some((argument) =>
    isSchemaOwnerTypeArgument(checker, proof, argument)
  ) === true;

const isSchemaIndexedAccess = (checker, proof, node) =>
  ts.isIndexedAccessTypeNode(node) &&
  ts.isTypeQueryNode(node.objectType) &&
  isSchemaValueEntity(checker, proof, node.objectType.exprName);

const isDecodedTypeAccessCandidate = (checker, proof, node) => {
  if (ts.isTypeQueryNode(node) && ts.isQualifiedName(node.exprName)) {
    return (
      checker.getSymbolAtLocation(node.exprName.right)?.escapedName ===
      proof.canonicalDecodedTypeProperty.escapedName
    );
  }
  return (
    ts.isIndexedAccessTypeNode(node) &&
    ts.isTypeQueryNode(node.objectType) &&
    ts.isLiteralTypeNode(node.indexType) &&
    ts.isStringLiteral(node.indexType.literal) &&
    node.indexType.literal.text ===
      String(proof.canonicalDecodedTypeProperty.escapedName)
  );
};

const getContractMembers = (declaration) => {
  if (ts.isInterfaceDeclaration(declaration)) return declaration.members;
  if (
    ts.isTypeAliasDeclaration(declaration) &&
    ts.isTypeLiteralNode(declaration.type)
  ) {
    return declaration.type.members;
  }
  return undefined;
};

const isFrameworkProps = (checker, proof, sourceFile, declaration) => {
  const members = getContractMembers(declaration);
  return (
    members !== undefined &&
    sourceFile.fileName.endsWith(".tsx") &&
    declaration.name.text.endsWith("Props") &&
    members.length > 0 &&
    members.every((member) => {
      if (
        ts.isCallSignatureDeclaration(member) ||
        ts.isConstructSignatureDeclaration(member) ||
        ts.isMethodSignature(member) ||
        (ts.isPropertySignature(member) &&
          member.type !== undefined &&
          ts.isFunctionTypeNode(member.type))
      ) {
        return true;
      }
      if (!ts.isPropertySignature(member) || member.type === undefined) {
        return false;
      }
      const name = getPropertyName(member.name);
      return (
        (name !== undefined &&
          displayAndProseNames.has(name) &&
          member.type.kind === ts.SyntaxKind.StringKeyword) ||
        isFrameworkTypeNode(member.type) ||
        isSchemaDerivedTypeNode(checker, proof, member.type)
      );
    })
  );
};

const createDiagnostic = (cwd, sourceFile, node, rule, message, remedy) => {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)
  );
  return {
    column: position.character + 1,
    filePath: path.relative(cwd, sourceFile.fileName).split(path.sep).join("/"),
    line: position.line + 1,
    message,
    remedy,
    rule,
  };
};

const createProgram = (cwd, projectPath) => {
  const config = ts.readConfigFile(projectPath, ts.sys.readFile);
  if (config.error !== undefined) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n")
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(projectPath)
  );
  const virtualAnchorPath = path.join(
    repoRoot,
    "packages/runtime/src",
    anchorFileName
  );
  const host = ts.createCompilerHost(parsed.options, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) =>
    path.resolve(fileName) === path.resolve(virtualAnchorPath) ||
    originalFileExists(fileName);
  host.readFile = (fileName) =>
    path.resolve(fileName) === path.resolve(virtualAnchorPath)
      ? anchorSource
      : originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    path.resolve(fileName) === path.resolve(virtualAnchorPath)
      ? ts.createSourceFile(
          fileName,
          anchorSource,
          languageVersion,
          true,
          ts.ScriptKind.TS
        )
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreate);

  const program = ts.createProgram({
    host,
    options: parsed.options,
    rootNames: [...parsed.fileNames, virtualAnchorPath],
  });
  const anchorFile = program.getSourceFile(virtualAnchorPath);
  if (anchorFile === undefined) {
    throw new Error("Gaia schema-contract checker could not create its anchor");
  }
  return { anchorFile, program };
};

/**
 * Analyze one configured TypeScript project for schema-contract ownership.
 *
 * @param {{ cwd: string; projectPath: string }} options Project and display-root paths.
 * @returns {Array<{ column: number; filePath: string; line: number; message: string; remedy: string; rule: string }>} Compiler-proven schema-contract diagnostics.
 */
export function analyzeSchemaContracts({ cwd, projectPath }) {
  const { anchorFile, program } = createProgram(cwd, projectPath);
  const checker = program.getTypeChecker();
  const schemaProof = createSchemaProof(checker, anchorFile);
  const canonicalBrandMarker = getCanonicalBrandMarker(checker, anchorFile);
  const diagnostics = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile === anchorFile ||
      sourceFile.isDeclarationFile ||
      sourceFile.fileName.includes(`${path.sep}node_modules${path.sep}`)
    ) {
      continue;
    }

    const visit = (node) => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        const targetType = checker.getTypeFromTypeNode(node.type);
        if (
          containsCanonicalBrandMarker(
            checker,
            targetType,
            canonicalBrandMarker
          )
        ) {
          diagnostics.push(
            createDiagnostic(
              cwd,
              sourceFile,
              node,
              "gaia/no-brand-cast",
              "Type assertion manufactures a compiler-proven Effect branded value.",
              brandCastRemedy
            )
          );
        }
      }

      if (ts.isTypeAliasDeclaration(node)) {
        const manualTypeLiteral =
          ts.isTypeLiteralNode(node.type) &&
          !isAllCallable(node.type.members) &&
          !isFrameworkProps(checker, schemaProof, sourceFile, node);
        const unprovenProjection =
          isCanonicalProjectionTypeNode(checker, schemaProof, node.type) &&
          !isSchemaDerivedTypeNode(checker, schemaProof, node.type);
        const unprovenSchemaTypeProjection =
          isCanonicalSchemaTypeProjectionCandidate(
            checker,
            schemaProof,
            node.type
          ) && !isSchemaDerivedTypeNode(checker, schemaProof, node.type);
        const unprovenSchemaGeneric =
          hasSchemaOwnerTypeArgument(checker, schemaProof, node.type) &&
          !isSchemaDerivedTypeNode(checker, schemaProof, node.type);
        const unprovenIndexedAccess =
          isSchemaIndexedAccess(checker, schemaProof, node.type) &&
          !isSchemaDerivedTypeNode(checker, schemaProof, node.type);
        const fakeSchemaType =
          isDecodedTypeAccessCandidate(checker, schemaProof, node.type) &&
          !isSchemaDerivedTypeNode(checker, schemaProof, node.type);

        if (
          manualTypeLiteral ||
          unprovenProjection ||
          unprovenSchemaTypeProjection ||
          unprovenSchemaGeneric ||
          unprovenIndexedAccess ||
          fakeSchemaType
        ) {
          diagnostics.push(
            createDiagnostic(
              cwd,
              sourceFile,
              node.name,
              "gaia/schema-first-data-contract",
              "Serializable data contract has no compiler-proven Schema origin.",
              schemaFirstRemedy
            )
          );
        }
      }

      if (
        ts.isInterfaceDeclaration(node) &&
        !isAllCallable(node.members) &&
        !isFrameworkProps(checker, schemaProof, sourceFile, node)
      ) {
        diagnostics.push(
          createDiagnostic(
            cwd,
            sourceFile,
            node.name,
            "gaia/schema-first-data-contract",
            "Serializable data contract has no compiler-proven Schema origin.",
            schemaFirstRemedy
          )
        );
      }

      if (
        ts.isTypeLiteralNode(node) &&
        !ts.isTypeAliasDeclaration(node.parent) &&
        !ts.isIntersectionTypeNode(node.parent) &&
        !isAllCallable(node.members)
      ) {
        diagnostics.push(
          createDiagnostic(
            cwd,
            sourceFile,
            node,
            "gaia/schema-first-data-contract",
            "Nested operation data contract has no compiler-proven Schema origin.",
            schemaFirstRemedy
          )
        );
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return diagnostics.sort(
    (left, right) =>
      left.filePath.localeCompare(right.filePath) ||
      left.line - right.line ||
      left.column - right.column ||
      left.rule.localeCompare(right.rule)
  );
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const cwd = process.cwd();
  const projectPath = path.resolve(cwd, process.argv[2] ?? "tsconfig.json");
  const diagnostics = analyzeSchemaContracts({ cwd, projectPath });
  for (const diagnostic of diagnostics) {
    process.stdout.write(
      `${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column} ${diagnostic.rule} ${diagnostic.message} Remedy: ${diagnostic.remedy}\n`
    );
  }
  process.exitCode = diagnostics.length === 0 ? 0 : 1;
}
