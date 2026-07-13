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
  export const __GaiaSuspendedSchema = Schema.suspend(
    () => __GaiaPlainSchema
  );
  export const __GaiaStructSchema = Schema.Struct({
    value: __GaiaPlainSchema
  });
  export const __GaiaStructFields = __GaiaStructSchema.fields;
  export const __GaiaUnionSchema = Schema.Union([__GaiaPlainSchema]);
  export const __GaiaUnionMembers = __GaiaUnionSchema.members;
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

const getCanonicalSchemaSuspendSymbol = (checker, anchorFile) => {
  const declaration = anchorFile.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (candidate) =>
          candidate.name.getText(anchorFile) === "__GaiaSuspendedSchema"
      )
  );
  const variable =
    declaration !== undefined && ts.isVariableStatement(declaration)
      ? declaration.declarationList.declarations.find(
          (candidate) =>
            candidate.name.getText(anchorFile) === "__GaiaSuspendedSchema"
        )
      : undefined;
  if (
    variable?.initializer === undefined ||
    !ts.isCallExpression(variable.initializer)
  ) {
    throw new Error(
      "Gaia schema-contract checker could not resolve Schema suspend composition"
    );
  }
  const symbol = checker.getSymbolAtLocation(variable.initializer.expression);
  if (symbol === undefined) {
    throw new Error(
      "Gaia schema-contract checker could not prove Schema suspend composition"
    );
  }
  return resolveAlias(checker, symbol);
};

const getCanonicalSchemaContainerPropertySymbols = (checker, anchorFile) => {
  const symbols = new Map();
  for (const name of ["__GaiaStructFields", "__GaiaUnionMembers"]) {
    const statement = anchorFile.statements.find(
      (candidate) =>
        ts.isVariableStatement(candidate) &&
        candidate.declarationList.declarations.some(
          (declaration) => declaration.name.getText(anchorFile) === name
        )
    );
    const declaration =
      statement !== undefined && ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.find(
            (candidate) => candidate.name.getText(anchorFile) === name
          )
        : undefined;
    if (
      declaration?.initializer === undefined ||
      !ts.isPropertyAccessExpression(declaration.initializer)
    ) {
      throw new Error(
        `Gaia schema-contract checker could not resolve canonical container property ${name}`
      );
    }
    const symbol = checker.getSymbolAtLocation(declaration.initializer.name);
    if (symbol === undefined) {
      throw new Error(
        `Gaia schema-contract checker could not prove canonical container property ${name}`
      );
    }
    const resolved = resolveAlias(checker, symbol);
    const declarations = new Set(
      (resolved.declarations ?? []).map(
        (candidate) =>
          `${candidate.getSourceFile().fileName}:${candidate.getStart()}:${candidate.getEnd()}`
      )
    );
    if (declarations.size === 0) {
      throw new Error(
        `Gaia schema-contract checker could not anchor canonical container property ${name}`
      );
    }
    symbols.set(resolved.escapedName, declarations);
  }
  return symbols;
};

const isCanonicalSchemaContainerProperty = (checker, proof, symbol) => {
  const resolved = resolveAlias(checker, symbol);
  const canonicalDeclarations =
    proof.canonicalSchemaContainerPropertySymbols.get(resolved.escapedName);
  return (
    canonicalDeclarations !== undefined &&
    (resolved.declarations ?? []).some((declaration) =>
      canonicalDeclarations.has(
        `${declaration.getSourceFile().fileName}:${declaration.getStart()}:${declaration.getEnd()}`
      )
    )
  );
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
  canonicalSchemaContainerPropertySymbols:
    getCanonicalSchemaContainerPropertySymbols(checker, anchorFile),
  canonicalSchemaSuspendSymbol: getCanonicalSchemaSuspendSymbol(
    checker,
    anchorFile
  ),
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

const defaultProvenanceLimits = Object.freeze({
  maxDepth: 64,
  maxShallowTypeDepth: 16,
  maxShallowTypes: 256,
  maxWorkItems: 4096,
});
const proofUnseen = 0;
const proofVisiting = 1;
const proofProven = 2;
const proofUnsafe = 3;

const isConstVariableDeclaration = (declaration) =>
  ts.isVariableDeclaration(declaration) &&
  ts.isVariableDeclarationList(declaration.parent) &&
  (declaration.parent.flags & ts.NodeFlags.Const) !== 0;

const getVariableStatement = (declaration) => {
  const list = declaration.parent;
  return ts.isVariableDeclarationList(list) &&
    ts.isVariableStatement(list.parent)
    ? list.parent
    : undefined;
};

const isExportedVariableDeclaration = (declaration) => {
  const statement = getVariableStatement(declaration);
  return (
    statement?.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    ) === true
  );
};

const createProgramReferenceIndex = (
  checker,
  program,
  anchorFile,
  includeIgnoredPathsForTesting
) => {
  const references = new Map();
  let complete = true;
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      try {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol !== undefined) {
          const resolved = resolveAlias(checker, symbol);
          const entries = references.get(resolved) ?? [];
          entries.push(node);
          references.set(resolved, entries);
        }
      } catch {
        complete = false;
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile === anchorFile ||
      sourceFile.isDeclarationFile ||
      (!includeIgnoredPathsForTesting &&
        sourceFile.fileName.includes(`${path.sep}node_modules${path.sep}`))
    ) {
      continue;
    }
    visit(sourceFile);
  }
  return { complete, references };
};

const isDeclarationName = (node) =>
  (ts.isVariableDeclaration(node.parent) ||
    ts.isBindingElement(node.parent) ||
    ts.isClassDeclaration(node.parent) ||
    ts.isFunctionDeclaration(node.parent) ||
    ts.isImportClause(node.parent) ||
    ts.isImportSpecifier(node.parent) ||
    ts.isParameter(node.parent) ||
    ts.isPropertyDeclaration(node.parent)) &&
  node.parent.name === node;

const isTypeOnlyReference = (node) => {
  let current = node.parent;
  while (current !== undefined && !ts.isStatement(current)) {
    if (ts.isTypeNode(current)) return true;
    current = current.parent;
  }
  return false;
};

const isWithin = (node, container) =>
  node.getStart() >= container.getStart() &&
  node.getEnd() <= container.getEnd();

const getReferenceAccess = (node) => {
  let current = node;
  while (
    (ts.isElementAccessExpression(current.parent) ||
      ts.isPropertyAccessExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
};

const isWriteReference = (node) => {
  const access = getReferenceAccess(node);
  const parent = access.parent;
  if (
    (ts.isPrefixUnaryExpression(parent) ||
      ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  if (
    ts.isDeleteExpression(parent) ||
    (ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      isWithin(access, parent.left))
  ) {
    return true;
  }
  return false;
};

const findInitializerDeclaration = (node) => {
  let current = node.parent;
  while (current !== undefined && !ts.isStatement(current)) {
    if (
      ts.isVariableDeclaration(current) &&
      current.initializer !== undefined &&
      isWithin(node, current.initializer)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
};

const getCanonicalCalleeSymbol = (checker, proof, expression) => {
  let current = expression;
  const seen = new Set();
  for (let depth = 0; depth < defaultProvenanceLimits.maxDepth; depth += 1) {
    let symbol;
    try {
      symbol = checker.getSymbolAtLocation(current);
    } catch {
      return undefined;
    }
    if (symbol === undefined) return undefined;
    const resolved = resolveAlias(checker, symbol);
    if (seen.has(resolved)) return undefined;
    seen.add(resolved);
    if (hasCanonicalSchemaDeclaration(checker, proof, resolved)) {
      return resolved;
    }
    const declarations = (resolved.declarations ?? []).filter(
      ts.isVariableDeclaration
    );
    if (
      declarations.length !== 1 ||
      !isConstVariableDeclaration(declarations[0]) ||
      declarations[0].initializer === undefined ||
      (!ts.isIdentifier(declarations[0].initializer) &&
        !ts.isPropertyAccessExpression(declarations[0].initializer))
    ) {
      return undefined;
    }
    current = declarations[0].initializer;
  }
  return undefined;
};

const isCanonicalCallShape = (checker, proof, node) => {
  if (getCanonicalCalleeSymbol(checker, proof, node.expression) !== undefined) {
    return true;
  }
  return (
    ts.isCallExpression(node.expression) &&
    getCanonicalCalleeSymbol(checker, proof, node.expression.expression) !==
      undefined
  );
};

const isCanonicalFactoryReference = (checker, proof, node) => {
  let current = node.parent;
  while (current !== undefined && !ts.isStatement(current)) {
    if (
      ts.isCallExpression(current) &&
      current.arguments.some((argument) => isWithin(node, argument)) &&
      isCanonicalCallShape(checker, proof, current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

const getFunctionReturnExpressions = (node) => {
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return [node.body];
  const expressions = [];
  const visit = (candidate) => {
    if (candidate !== node && ts.isFunctionLike(candidate)) return;
    if (ts.isReturnStatement(candidate)) {
      if (candidate.expression !== undefined)
        expressions.push(candidate.expression);
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node.body);
  return expressions;
};

const shallowTypeMayContainSchema = (checker, proof, rootType, limits) => {
  const work = [{ depth: 0, type: rootType }];
  const seen = new Set();
  while (work.length > 0) {
    const { depth, type } = work.pop();
    if (
      seen.has(type) ||
      seen.size >= limits.maxShallowTypes ||
      depth > limits.maxShallowTypeDepth
    ) {
      if (
        seen.size >= limits.maxShallowTypes ||
        depth > limits.maxShallowTypeDepth
      ) {
        return true;
      }
      continue;
    }
    seen.add(type);
    try {
      if (isSchemaValueType(checker, proof, type)) return true;
      if (type.isUnionOrIntersection()) {
        for (const member of type.types)
          work.push({ depth: depth + 1, type: member });
      }
      for (const argument of type.aliasTypeArguments ?? []) {
        work.push({ depth: depth + 1, type: argument });
      }
      if (
        (type.flags & ts.TypeFlags.Object) !== 0 &&
        (type.objectFlags & ts.ObjectFlags.Reference) !== 0
      ) {
        for (const argument of checker.getTypeArguments(type)) {
          work.push({ depth: depth + 1, type: argument });
        }
      }
      for (const indexInfo of checker.getIndexInfosOfType(type)) {
        work.push({ depth: depth + 1, type: indexInfo.type });
      }
      if (
        (type.flags & ts.TypeFlags.Object) !== 0 &&
        !checker.isArrayType(type) &&
        !checker.isTupleType(type)
      ) {
        for (const property of checker.getPropertiesOfType(type)) {
          const declaration =
            property.valueDeclaration ?? property.declarations?.[0];
          if (declaration === undefined) return true;
          work.push({
            depth: depth + 1,
            type: checker.getTypeOfSymbolAtLocation(property, declaration),
          });
        }
      }
    } catch {
      return true;
    }
  }
  return false;
};

const createSchemaProvenanceSession = (checker, proof, limits) => {
  const states = new Map();
  const edges = new Map();
  const symbolWork = [];
  const queuedSymbols = new Set();
  const root = { root: true };
  let unsafe = false;
  let workItems = 0;

  const consume = (depth = 0) => {
    workItems += 1;
    if (workItems > limits.maxWorkItems || depth > limits.maxDepth) {
      unsafe = true;
      return false;
    }
    return true;
  };

  const getSymbol = (node) => {
    try {
      const symbol = checker.getSymbolAtLocation(node);
      return symbol === undefined ? undefined : resolveAlias(checker, symbol);
    } catch {
      unsafe = true;
      return undefined;
    }
  };

  const expressionMayContainSchema = (node) => {
    try {
      if (
        shallowTypeMayContainSchema(
          checker,
          proof,
          checker.getTypeAtLocation(node),
          limits
        )
      ) {
        return true;
      }
    } catch {
      return true;
    }
    const work = [{ depth: 0, node }];
    let seen = 0;
    while (work.length > 0 && seen < limits.maxShallowTypes) {
      const item = work.pop();
      if (item.depth > limits.maxShallowTypeDepth) return true;
      seen += 1;
      try {
        if (
          isSchemaValueType(
            checker,
            proof,
            checker.getTypeAtLocation(item.node)
          )
        ) {
          return true;
        }
      } catch {
        return true;
      }
      if (ts.isFunctionLike(item.node) && item.node !== node) continue;
      if (
        ts.isIdentifier(item.node) ||
        ts.isPropertyAccessExpression(item.node)
      ) {
        try {
          const symbol = checker.getSymbolAtLocation(item.node);
          const resolved =
            symbol === undefined ? undefined : resolveAlias(checker, symbol);
          for (const declaration of resolved?.declarations ?? []) {
            if (
              ts.isVariableDeclaration(declaration) &&
              declaration.initializer !== undefined &&
              declaration.initializer !== item.node
            ) {
              work.push({
                depth: item.depth + 1,
                node: declaration.initializer,
              });
            }
          }
        } catch {
          return true;
        }
      }
      ts.forEachChild(item.node, (child) =>
        work.push({ depth: item.depth + 1, node: child })
      );
    }
    return work.length > 0;
  };

  const addEdge = (from, symbol, lazy) => {
    const resolved = resolveAlias(checker, symbol);
    const current = edges.get(from) ?? [];
    current.push({ lazy, symbol: resolved });
    edges.set(from, current);
    if (
      !hasCanonicalSchemaDeclaration(checker, proof, resolved) &&
      !queuedSymbols.has(resolved)
    ) {
      queuedSymbols.add(resolved);
      states.set(resolved, proofUnseen);
      symbolWork.push(resolved);
    }
  };

  const hasUnsafeSchemaWrite = (symbol) =>
    (proof.referenceIndex.references.get(symbol) ?? []).some(
      (reference) =>
        !isDeclarationName(reference) &&
        !isTypeOnlyReference(reference) &&
        isWriteReference(reference)
    );

  const getContainerClosure = (initialSymbol) => {
    if (!proof.referenceIndex.complete) {
      unsafe = true;
      return [];
    }
    const queue = [resolveAlias(checker, initialSymbol)];
    const declarations = new Map();
    const aliasEdges = new Map();
    const seen = new Set();
    while (queue.length > 0 && !unsafe) {
      const symbol = queue.pop();
      if (!consume() || seen.has(symbol)) continue;
      seen.add(symbol);
      const candidates = (symbol.declarations ?? []).filter(
        ts.isVariableDeclaration
      );
      if (
        candidates.length !== 1 ||
        !isConstVariableDeclaration(candidates[0]) ||
        candidates[0].initializer === undefined ||
        candidates[0].getSourceFile().isDeclarationFile ||
        isExportedVariableDeclaration(candidates[0])
      ) {
        unsafe = true;
        break;
      }
      declarations.set(symbol, candidates[0]);
      for (const reference of proof.referenceIndex.references.get(symbol) ??
        []) {
        if (
          !consume() ||
          isDeclarationName(reference) ||
          isTypeOnlyReference(reference)
        ) {
          continue;
        }
        if (isWriteReference(reference)) {
          unsafe = true;
          break;
        }
        const aliasDeclaration = findInitializerDeclaration(reference);
        if (aliasDeclaration !== undefined) {
          if (
            !isConstVariableDeclaration(aliasDeclaration) ||
            isExportedVariableDeclaration(aliasDeclaration) ||
            !ts.isIdentifier(aliasDeclaration.name)
          ) {
            unsafe = true;
            break;
          }
          const aliasSymbol = getSymbol(aliasDeclaration.name);
          if (aliasSymbol === undefined) {
            unsafe = true;
            break;
          }
          const outgoing = aliasEdges.get(symbol) ?? [];
          outgoing.push(aliasSymbol);
          aliasEdges.set(symbol, outgoing);
          queue.push(aliasSymbol);
          continue;
        }
        if (!isCanonicalFactoryReference(checker, proof, reference)) {
          unsafe = true;
          break;
        }
      }
    }
    if (unsafe) return [];

    const indegrees = new Map([...seen].map((symbol) => [symbol, 0]));
    for (const outgoing of aliasEdges.values()) {
      for (const target of outgoing) {
        if (indegrees.has(target))
          indegrees.set(target, indegrees.get(target) + 1);
      }
    }
    const ready = [...indegrees]
      .filter(([, degree]) => degree === 0)
      .map(([symbol]) => symbol);
    let visited = 0;
    while (ready.length > 0) {
      const symbol = ready.pop();
      visited += 1;
      for (const target of aliasEdges.get(symbol) ?? []) {
        if (!indegrees.has(target)) continue;
        const next = indegrees.get(target) - 1;
        indegrees.set(target, next);
        if (next === 0) ready.push(target);
      }
    }
    if (visited !== indegrees.size) {
      unsafe = true;
      return [];
    }
    return [...declarations.values()].map(
      (declaration) => declaration.initializer
    );
  };

  const processExpressions = (initialItems) => {
    const work = [...initialItems];
    const seenNodes = new Set();
    while (work.length > 0 && !unsafe) {
      const item = work.pop();
      let node = item.node;
      if (!consume(item.depth)) break;
      if (seenNodes.has(node)) continue;
      seenNodes.add(node);

      if (
        ts.isNonNullExpression(node) ||
        ts.isParenthesizedExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isSpreadElement(node) ||
        ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
          ts.isConstTypeReference(node.type))
      ) {
        work.push({ ...item, depth: item.depth + 1, node: node.expression });
        continue;
      }
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        unsafe = true;
        break;
      }

      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (ts.isPropertyAssignment(property)) {
            work.push({
              ...item,
              depth: item.depth + 1,
              node: property.initializer,
            });
          } else if (ts.isShorthandPropertyAssignment(property)) {
            work.push({ ...item, depth: item.depth + 1, node: property.name });
          } else if (ts.isSpreadAssignment(property)) {
            work.push({
              ...item,
              depth: item.depth + 1,
              node: property.expression,
            });
          } else {
            unsafe = true;
            break;
          }
        }
        continue;
      }
      if (ts.isArrayLiteralExpression(node)) {
        for (const element of node.elements) {
          work.push({
            ...item,
            depth: item.depth + 1,
            node: ts.isSpreadElement(element) ? element.expression : element,
          });
        }
        continue;
      }
      if (ts.isConditionalExpression(node)) {
        work.push(
          { ...item, depth: item.depth + 1, node: node.whenTrue },
          { ...item, depth: item.depth + 1, node: node.whenFalse }
        );
        continue;
      }

      if (ts.isCallExpression(node)) {
        const canonicalCallee = getCanonicalCalleeSymbol(
          checker,
          proof,
          node.expression
        );
        if (canonicalCallee !== undefined) {
          if (ts.isPropertyAccessExpression(node.expression)) {
            const receiver = node.expression.expression;
            try {
              if (
                isSchemaValueType(
                  checker,
                  proof,
                  checker.getTypeAtLocation(receiver)
                )
              ) {
                work.push({ ...item, depth: item.depth + 1, node: receiver });
              }
            } catch {
              unsafe = true;
              break;
            }
          }
          if (canonicalCallee === proof.canonicalSchemaSuspendSymbol) {
            const callback = node.arguments[0];
            if (
              callback === undefined ||
              (!ts.isArrowFunction(callback) &&
                !ts.isFunctionExpression(callback))
            ) {
              unsafe = true;
              break;
            }
            const returns = getFunctionReturnExpressions(callback);
            if (returns.length === 0) {
              unsafe = true;
              break;
            }
            for (const returned of returns) {
              work.push({
                ...item,
                depth: item.depth + 1,
                lazy: true,
                node: returned,
              });
            }
          } else {
            for (const argument of node.arguments) {
              if (expressionMayContainSchema(argument)) {
                work.push({ ...item, depth: item.depth + 1, node: argument });
              }
            }
          }
          continue;
        }

        if (
          ts.isCallExpression(node.expression) &&
          getCanonicalCalleeSymbol(
            checker,
            proof,
            node.expression.expression
          ) !== undefined
        ) {
          work.push({ ...item, depth: item.depth + 1, node: node.expression });
          for (const argument of node.arguments) {
            if (expressionMayContainSchema(argument)) {
              work.push({ ...item, depth: item.depth + 1, node: argument });
            }
          }
          continue;
        }

        if (ts.isPropertyAccessExpression(node.expression)) {
          const method = getSymbol(node.expression.name);
          if (method === proof.canonicalSchemaPipeSymbol) {
            work.push({
              ...item,
              depth: item.depth + 1,
              node: node.expression.expression,
            });
            for (const argument of node.arguments) {
              if (!ts.isCallExpression(argument)) {
                unsafe = true;
                break;
              }
              work.push({ ...item, depth: item.depth + 1, node: argument });
            }
            continue;
          }
        }
        unsafe = true;
        continue;
      }

      if (ts.isPropertyAccessExpression(node)) {
        const property = getSymbol(node.name);
        if (
          property !== undefined &&
          isCanonicalSchemaContainerProperty(checker, proof, property)
        ) {
          work.push({
            ...item,
            depth: item.depth + 1,
            node: node.expression,
          });
          continue;
        }
      }

      if (
        ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) {
        if (
          ts.isElementAccessExpression(node) &&
          node.argumentExpression !== undefined &&
          !ts.isStringLiteralLike(node.argumentExpression) &&
          !ts.isNumericLiteral(node.argumentExpression)
        ) {
          unsafe = true;
          break;
        }
        let valueType;
        try {
          valueType = checker.getTypeAtLocation(node);
        } catch {
          unsafe = true;
          break;
        }
        const symbol = getSymbol(node);
        if (isSchemaValueType(checker, proof, valueType)) {
          if (symbol === undefined) {
            unsafe = true;
            break;
          }
          addEdge(item.owner, symbol, item.lazy);
          continue;
        }
        if (expressionMayContainSchema(node)) {
          if (symbol === undefined) {
            unsafe = true;
            break;
          }
          const initializers = getContainerClosure(symbol);
          if (initializers.length === 0) {
            unsafe = true;
            break;
          }
          for (const initializer of initializers) {
            work.push({ ...item, depth: item.depth + 1, node: initializer });
          }
          continue;
        }
        unsafe = true;
        break;
      }

      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const returns = getFunctionReturnExpressions(node);
        if (returns.length === 0 && expressionMayContainSchema(node)) {
          unsafe = true;
        }
        for (const returned of returns) {
          work.push({ ...item, depth: item.depth + 1, node: returned });
        }
        continue;
      }

      unsafe = true;
    }
  };

  const processSymbol = (symbol) => {
    if (!consume()) return;
    if (hasCanonicalSchemaDeclaration(checker, proof, symbol)) {
      states.set(symbol, proofProven);
      return;
    }
    states.set(symbol, proofVisiting);
    const declarations = symbol.declarations ?? [];
    const variableDeclarations = declarations.filter(ts.isVariableDeclaration);
    if (variableDeclarations.length === 1) {
      const declaration = variableDeclarations[0];
      if (
        !isConstVariableDeclaration(declaration) ||
        declaration.initializer === undefined ||
        declaration.getSourceFile().isDeclarationFile ||
        hasUnsafeSchemaWrite(symbol)
      ) {
        states.set(symbol, proofUnsafe);
        unsafe = true;
        return;
      }
      processExpressions([
        { depth: 0, lazy: false, node: declaration.initializer, owner: symbol },
      ]);
      return;
    }
    const classDeclaration = declarations.find(ts.isClassDeclaration);
    if (classDeclaration !== undefined) {
      const heritage = classDeclaration.heritageClauses?.flatMap((clause) =>
        clause.types.map((type) => type.expression)
      );
      if (heritage === undefined || heritage.length === 0) {
        states.set(symbol, proofUnsafe);
        unsafe = true;
        return;
      }
      processExpressions(
        heritage.map((node) => ({ depth: 0, lazy: false, node, owner: symbol }))
      );
      return;
    }
    states.set(symbol, proofUnsafe);
    unsafe = true;
  };

  const finish = () => {
    while (symbolWork.length > 0) {
      if (unsafe) break;
      const symbol = symbolWork.shift();
      if (states.get(symbol) === proofUnseen) processSymbol(symbol);
    }
    if (unsafe || [...states.values()].includes(proofUnsafe)) return false;
    const nodes = new Set([root, ...states.keys()]);
    const indegrees = new Map([...nodes].map((node) => [node, 0]));
    for (const [from, outgoing] of edges) {
      if (!nodes.has(from)) continue;
      for (const edge of outgoing) {
        if (edge.lazy || !nodes.has(edge.symbol)) continue;
        indegrees.set(edge.symbol, indegrees.get(edge.symbol) + 1);
      }
    }
    const ready = [...indegrees]
      .filter(([, degree]) => degree === 0)
      .map(([node]) => node);
    let visited = 0;
    while (ready.length > 0) {
      const node = ready.pop();
      visited += 1;
      for (const edge of edges.get(node) ?? []) {
        if (edge.lazy || !indegrees.has(edge.symbol)) continue;
        const next = indegrees.get(edge.symbol) - 1;
        indegrees.set(edge.symbol, next);
        if (next === 0) ready.push(edge.symbol);
      }
    }
    if (visited !== indegrees.size) return false;
    for (const symbol of states.keys()) states.set(symbol, proofProven);
    return true;
  };

  return {
    proveExpression(node) {
      processExpressions([{ depth: 0, lazy: false, node, owner: root }]);
      return finish();
    },
    proveSymbol(symbol) {
      addEdge(root, symbol, false);
      return finish();
    },
  };
};

const getProvenanceLimits = (proof) => ({
  ...defaultProvenanceLimits,
  ...proof.provenanceLimits,
});

const isCanonicalSchemaApiCall = (checker, proof, node) =>
  ts.isCallExpression(node) &&
  createSchemaProvenanceSession(
    checker,
    proof,
    getProvenanceLimits(proof)
  ).proveExpression(node);

const isCanonicalSchemaValueSymbol = (checker, proof, symbol) =>
  createSchemaProvenanceSession(
    checker,
    proof,
    getProvenanceLimits(proof)
  ).proveSymbol(resolveAlias(checker, symbol));

function isCanonicalSchemaValueExpression(checker, proof, node) {
  try {
    if (!isSchemaValueType(checker, proof, checker.getTypeAtLocation(node))) {
      return false;
    }
  } catch {
    return false;
  }
  return createSchemaProvenanceSession(
    checker,
    proof,
    getProvenanceLimits(proof)
  ).proveExpression(node);
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
 * @param {{ cwd: string; includeIgnoredPathsForTesting?: boolean; projectPath: string; provenanceLimits?: Partial<typeof defaultProvenanceLimits> }} options Project, display-root, and optional test-only proof controls.
 * @returns {Array<{ column: number; filePath: string; line: number; message: string; remedy: string; rule: string }>} Compiler-proven schema-contract diagnostics.
 */
export function analyzeSchemaContracts({
  cwd,
  includeIgnoredPathsForTesting = false,
  projectPath,
  provenanceLimits,
}) {
  const { anchorFile, program } = createProgram(cwd, projectPath);
  const checker = program.getTypeChecker();
  const schemaProof = createSchemaProof(checker, anchorFile);
  schemaProof.provenanceLimits = provenanceLimits;
  schemaProof.referenceIndex = createProgramReferenceIndex(
    checker,
    program,
    anchorFile,
    includeIgnoredPathsForTesting
  );
  const canonicalBrandMarker = getCanonicalBrandMarker(checker, anchorFile);
  const diagnostics = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile === anchorFile ||
      sourceFile.isDeclarationFile ||
      (!includeIgnoredPathsForTesting &&
        sourceFile.fileName.includes(`${path.sep}node_modules${path.sep}`))
    ) {
      continue;
    }

    const visit = (node) => {
      if (
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        !ts.isConstTypeReference(node.type)
      ) {
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
