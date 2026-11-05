import ts from "typescript";

type Table = "Agent" | "Soul" | "Memory";
type State = Map<string, string>;

export function assertRestoreWriteOrder(text: string, table: Table, fields: ReadonlySet<string>, file: string): void {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = name => name === file ? source : undefined;
  const program = ts.createProgram([file], { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  const location = (node: ts.Node): string => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  function fail(node: ts.Node, message: string): never { throw new Error(`${location(node)}: ${message}`); }
  if (program.getSyntacticDiagnostics().length) fail(source, "resource does not parse");
  const unwrap = (node: ts.Node): ts.Node => {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node)) node = node.expression;
    return node;
  };
  const named = (node: ts.Node, name: string): boolean => ts.isIdentifier(unwrap(node)) && unwrap(node).getText(source) === name;
  const property = (node: ts.Node, name: string): node is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(node) && node.name.text === name;
  const nodes = (node: ts.Node): ts.Node[] => {
    const result: ts.Node[] = [node];
    node.forEachChild(child => { result.push(...nodes(child)); });
    return result;
  };
  const resource = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === table);
  if (!resource || !ts.isClassDeclaration(resource)) fail(source, `missing ${table} class`);
  const methods = new Map(resource.members.filter(ts.isMethodDeclaration).map(method => [method.name.getText(source), method]));
  const put = methods.get("put");
  if (!put?.body) fail(resource, "missing put body");
  const declarations = new Map<ts.Symbol, ts.VariableDeclaration>();
  for (const node of nodes(resource)) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) declarations.set(symbol, node);
    }
  }
  const declaration = (node: ts.Node): ts.VariableDeclaration | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol ? declarations.get(symbol) : undefined;
  };
  const rowKey = (node: ts.Node): string => `row:${declaration(node)?.getStart(source)}`;
  const storedBinding = (node: ts.Node): boolean => {
    const value = declaration(node)?.initializer;
    if (!value) return false;
    const row = unwrap(value);
    if (!property(row, "row")) return false;
    const read = declaration(row.expression)?.initializer;
    if (!read) return false;
    const call = unwrap(read);
    return ts.isCallExpression(call) && named(call.expression, "resolveStoredRow") &&
      call.arguments.some(arg => ts.isStringLiteral(arg) && arg.text === "Agent");
  };
  const contentSymbols = new Set<ts.Symbol>();
  const addContent = (method: ts.MethodDeclaration): void => {
    const parameter = method.parameters[0]?.name;
    if (!parameter || !ts.isIdentifier(parameter) || parameter.text !== "content") fail(method, "unsupported content parameter");
    const symbol = checker.getSymbolAtLocation(parameter);
    if (!symbol) fail(parameter, "unresolved content binding");
    contentSymbols.add(symbol);
  };
  addContent(put);
  const isContent = (node: ts.Node): boolean => ts.isIdentifier(node) && contentSymbols.has(checker.getSymbolAtLocation(node)!);
  const memberValue = (node: ts.Node | undefined, key: string): ts.Expression | undefined => node && ts.isObjectLiteralExpression(node)
    ? node.properties.find((member): member is ts.PropertyAssignment => ts.isPropertyAssignment(member) && member.name.getText(source) === key)?.initializer : undefined;
  const literal = (node: ts.Node | undefined, value: string): boolean => !!node && ts.isStringLiteral(unwrap(node)) && (unwrap(node) as ts.StringLiteral).text === value;
  const isRefusalCall = (node: ts.Node): boolean => {
    const call = unwrap(node);
    if (!ts.isCallExpression(call)) return false;
    const helper = declaration(call.expression)?.initializer;
    if (!helper || !ts.isArrowFunction(helper)) return false;
    const response = unwrap(helper.body);
    if (!ts.isNewExpression(response) || !named(response.expression, "Response")) return false;
    const [body, options] = response.arguments ?? [];
    if (!body || !ts.isCallExpression(body) || !property(body.expression, "stringify") || !named(body.expression.expression, "JSON")) return false;
    return literal(memberValue(body.arguments[0], "error"), "agent_put_requires_existing") && memberValue(options, "status")?.getText(source) === "404";
  };
  const goneReturn = (node: ts.Node): boolean => ts.isReturnStatement(node) && literal(memberValue(node.expression, "kind"), "gone");
  const goneRefused = (guard: ts.IfStatement): boolean => {
    const outcome = [...declarations.values()].find(item => {
      if (!item.initializer) return false;
      const call = unwrap(item.initializer);
      return ts.isCallExpression(call) && named(call.expression, "withOwnedTransaction") && call.arguments.some(arg => nodes(arg).includes(guard));
    });
    const declarationList = outcome?.parent;
    const declarationStatement = declarationList?.parent;
    const block = declarationStatement?.parent;
    if (!outcome || !declarationStatement || !ts.isVariableStatement(declarationStatement) || !block || !ts.isBlock(block)) return false;
    const outcomeSymbol = checker.getSymbolAtLocation(outcome.name);
    type RefusalPath = "refused" | "continues" | "unsafe";
    const after = (statements: readonly ts.Statement[]): RefusalPath => {
      for (const item of statements) {
        const result = step(item);
        if (result !== "continues") return result;
      }
      return "continues";
    };
    const step = (item: ts.Statement): RefusalPath => {
      if (ts.isBlock(item)) return after(item.statements);
      if (ts.isReturnStatement(item)) return item.expression && isRefusalCall(item.expression) ? "refused" : "unsafe";
      if (!ts.isIfStatement(item)) return "unsafe";
      const condition = unwrap(item.expression);
      if (ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        property(condition.left, "kind") && checker.getSymbolAtLocation(condition.left.expression) === outcomeSymbol && ts.isStringLiteral(condition.right)) {
        return condition.right.text === "gone" ? step(item.thenStatement) : item.elseStatement ? step(item.elseStatement) : "continues";
      }
      const yes = step(item.thenStatement);
      const no = item.elseStatement ? step(item.elseStatement) : "continues";
      if (yes === "unsafe" || no === "unsafe") return "unsafe";
      return yes === "refused" && no === "refused" ? "refused" : "continues";
    };
    return after(block.statements.slice(block.statements.indexOf(declarationStatement) + 1)) === "refused";
  };
  const merge = (states: Array<State | null>): State | null => {
    const live = states.filter((state): state is State => state !== null);
    if (!live.length) return null;
    const result = new Map(live[0]);
    for (const state of live) for (const [key, reason] of state) result.set(key, reason);
    return result;
  };
  const branch = (state: State, node: ts.Node, arm: string): State => new Map([...state].map(([key, reason]) => [key, `${arm} branch at ${location(node)} (via ${reason})`]));
  let calls = 0;
  const activeMethods = new Set<string>();
  const expression = (node: ts.Node, state: State): State => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      if (!node.body) fail(node, "missing callback body");
      if (ts.isBlock(node.body)) statement(node.body, new Map(state));
      else expression(node.body, new Map(state));
      return state;
    }
    if (ts.isConditionalExpression(node)) {
      state = expression(node.condition, state);
      return merge([expression(node.whenTrue, branch(state, node, "true")), expression(node.whenFalse, branch(state, node, "false"))])!;
    }
    if (ts.isBinaryExpression(node)) {
      state = expression(node.left, state);
      const operator = node.operatorToken.kind;
      if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(operator)) {
        const right = expression(node.right, branch(state, node, "right"));
        if (isContent(node.left)) for (const field of fields) right.set(field, `content replacement at ${location(node)}`);
        return merge([branch(state, node, "short-circuit"), right])!;
      }
      state = expression(node.right, state);
      if (isContent(node.left) && operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) for (const field of fields) state.set(field, `content replacement at ${location(node)}`);
      if (ts.isPropertyAccessExpression(node.left) && isContent(node.left.expression) && fields.has(node.left.name.text)) {
        const field = node.left.name.text;
        if (operator !== ts.SyntaxKind.EqualsToken) fail(node, `unsupported assignment to content.${field}`);
        if (table === "Agent") {
          const rhs = unwrap(node.right);
          if (!property(rhs, field) || !storedBinding(rhs.expression)) fail(node, `content.${field} must read the stored row's ${field}`);
          if (state.has(rowKey(rhs.expression))) fail(node, `content.${field} has no missing-stored-row refusal before assignment`);
        }
        state.delete(field);
      }
      return state;
    }
    if (ts.isDeleteExpression(node) && ts.isPropertyAccessExpression(node.expression) && isContent(node.expression.expression) && fields.has(node.expression.name.text)) {
      state.set(node.expression.name.text, `delete at ${location(node)}`);
    }
    if (ts.isCallExpression(node)) {
      state = expression(node.expression, state);
      const skipped = node.flags & ts.NodeFlags.OptionalChain ? new Map(state) : null;
      for (const arg of node.arguments) state = expression(arg, state);
      const callee = node.expression;
      const validate = table === "Soul" && property(callee, "validate") && callee.expression.kind === ts.SyntaxKind.ThisKeyword && node.arguments.some(isContent);
      const superPut = table !== "Soul" && property(callee, "put") && callee.expression.kind === ts.SyntaxKind.SuperKeyword;
      const memoryPut = table === "Memory" && property(callee, "put") && property(callee.expression, "Memory") &&
        property(callee.expression.expression, "flair") && named(unwrap(callee.expression.expression.expression), "databases") && node.arguments.some(isContent);
      if (superPut && !node.arguments.some(isContent)) fail(node, "super.put does not receive the checked content binding");
      if (validate || superPut || memoryPut) {
        calls++;
        for (const field of fields) if (state.has(field)) fail(node, `content.${field} is not assigned before ${validate ? "this.validate" : "put write"}; ${state.get(field)}`);
      }
      if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword && methods.has(callee.name.text)) {
        const method = methods.get(callee.name.text)!;
        if (callee.name.text !== "putLocked") return merge([state, skipped])!;
        if (!node.arguments[0] || !isContent(node.arguments[0]) || activeMethods.has(callee.name.text)) fail(node, "unsupported putLocked delegation");
        addContent(method);
        activeMethods.add(callee.name.text);
        if (!method.body) fail(method, "missing delegated body");
        statement(method.body, new Map(state));
        activeMethods.delete(callee.name.text);
      }
      return merge([state, skipped])!;
    }
    if (ts.isClassExpression(node)) fail(node, "unsupported class expression on write path");
    const skipped = (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) && node.flags & ts.NodeFlags.OptionalChain ? new Map(state) : null;
    node.forEachChild(child => { state = expression(child, state); });
    return merge([state, skipped])!;
  };
  const statement = (node: ts.Statement, state: State): State | null => {
    if (ts.isBlock(node)) {
      let current: State | null = state;
      for (const child of node.statements) {
        if (!current) break;
        current = statement(child, current);
      }
      return current;
    }
    if (ts.isIfStatement(node)) {
      state = expression(node.expression, state);
      const yes = branch(state, node, "then");
      const no = branch(state, node, "else");
      const condition = unwrap(node.expression);
      if (table === "Agent" && ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken && storedBinding(condition.operand)) {
        if (!goneReturn(node.thenStatement) || !goneRefused(node)) fail(node, "missing stored row must return gone and map to agent_put_requires_existing");
        no.delete(rowKey(condition.operand));
      }
      return merge([statement(node.thenStatement, yes), node.elseStatement ? statement(node.elseStatement, no) : no]);
    }
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      if (node.expression) expression(node.expression, state);
      return null;
    }
    if (ts.isTryStatement(node)) {
      const tried = statement(node.tryBlock, new Map(state));
      const caught = node.catchClause ? statement(node.catchClause.block, branch(state, node, "catch")) : null;
      const result = merge([tried, caught]);
      if (node.finallyBlock) {
        const final = statement(node.finallyBlock, merge([state, result])!);
        return result && final;
      }
      return result;
    }
    if (ts.isForOfStatement(node) && ts.isExpressionStatement(node.statement) && !nodes(node).some(child => ts.isIdentifier(child) && isContent(child))) {
      expression(node.expression, new Map(state));
      expression(node.statement.expression, new Map(state));
      return state;
    }
    if (ts.isVariableStatement(node)) {
      for (const item of node.declarationList.declarations) {
        if (item.initializer) state = expression(item.initializer, state);
        if (table === "Agent" && storedBinding(item.name)) state.set(rowKey(item.name), `stored row not guarded at ${location(item)}`);
      }
      return state;
    }
    if (ts.isExpressionStatement(node)) return expression(node.expression, state);
    if (ts.isEmptyStatement(node)) return state;
    fail(node, `unsupported write-path statement: ${ts.SyntaxKind[node.kind]}`);
  };
  statement(put.body, new Map([...fields].map(field => [field, `entry to ${table}.put`])));
  if (!calls) fail(put, "no validation/write call checked");
}
