/* @internal */
namespace ts.deno {
  export type IsNodeSourceFileCallback = (sourceFile: SourceFile) => boolean;

  let isNodeSourceFile: IsNodeSourceFileCallback = () => false;

  export function setIsNodeSourceFileCallback(callback: IsNodeSourceFileCallback) {
    isNodeSourceFile = callback;
  }

  // When upgrading:
  // 1. Inspect all usages of "globals" and "globalThisSymbol" in checker.ts
  //    - Beware that `globalThisType` might refer to the global `this` type
  //      and not the global `globalThis` type
  // 2. Inspect the "special" typescript types and add them to the list below.
  // 3. Inspect the types in @types/node for anything that might need to go below
  //    as well.

  const ignoredGlobalNames = new Set([
    // checker.ts "special" types
    "Object",
    "Function",
    "CallableFunction",
    "NewableFunction",
    "Array",
    "ReadonlyArray",
    "String",
    "Number",
    "Boolean",
    "RegExpr",
    "ThisType",
    "NonNullable",
    // types in @types/node that we don't want to create duplicates of
    "Int8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
  ].map(s => s as ts.__String));

  export function createDenoContext({
    mergeSymbol,
    globals,
    nodeGlobals,
  }: {
    mergeSymbol(target: Symbol, source: Symbol, unidirectional?: boolean): Symbol;
    globals: SymbolTable;
    nodeGlobals: SymbolTable;
  }) {
    return {
      hasNodeSourceFile,
      isAllowedNodeGlobalName,
      getGlobalsForName,
      mergeGlobalSymbolTable,
      combinedGlobals: createNodeGlobalsSymbolTable(),
    };

    function hasNodeSourceFile(node: Node | undefined) {
      if (!node) return false;
      const sourceFile = getSourceFileOfNode(node);
      return isNodeSourceFile(sourceFile);
    }

    function isAllowedNodeGlobalName(id: ts.__String) {
      return !ignoredGlobalNames.has(id);
    }

    function getGlobalsForName(id: ts.__String) {
      return isAllowedNodeGlobalName(id) ? nodeGlobals : globals;
    }

    function mergeGlobalSymbolTable(node: Node, source: SymbolTable, unidirectional = false) {
      const isNodeFile = hasNodeSourceFile(node);
      source.forEach((sourceSymbol, id) => {
        const target = isNodeFile ? getGlobalsForName(id) : globals;
        const targetSymbol = target.get(id);
        target.set(id, targetSymbol ? mergeSymbol(targetSymbol, sourceSymbol, unidirectional) : sourceSymbol);
      });
    }

    function createNodeGlobalsSymbolTable() {
      return new Proxy(globals, {
        get(target, prop: string | symbol, receiver) {
          if (prop === "get") {
            return (key: ts.__String) => {
              return nodeGlobals.get(key) ?? globals.get(key);
            };
          } else if (prop === "has") {
            return (key: ts.__String) => {
              return nodeGlobals.has(key) || globals.has(key);
            };
          } else if (prop === "size") {
            let i = 0;
            forEachEntry(() => {
              i++;
            });
            return i;
          } else if (prop === "forEach") {
            return (action: (value: Symbol, key: ts.__String) => void) => {
              forEachEntry(([key, value]) => {
                action(value, key);
              });
            };
          } else if (prop === "entries") {
            return () => {
              return getEntries(kv => kv);
            };
          } else if (prop === "keys") {
            return () => {
              return getEntries(kv => kv[0]);
            };
          } else if (prop === "values") {
            return () => {
              return getEntries(kv => kv[1]);
            };
          } else if (prop === Symbol.iterator) {
            return () => {
              return getEntries(kv => kv);
            };
          } else {
            const value = (target as any)[prop];
            if (value instanceof Function) {
              return function (this: any, ...args: any[]) {
                return value.apply(this === receiver ? target : this, args);
              };
            }
            return value;
          }
        },
      });

      function forEachEntry(action: (value: [__String, Symbol]) => void) {
        const iterator = getEntries((entry) => {
          action(entry);
        });
        // drain the iterator to do the action
        while (!iterator.next().done) {}
      }

      function* getEntries<R>(
        transform: (value: [__String, Symbol]) => R
      ) {
        const foundKeys = new Set<ts.__String>();
        for (const entries of [nodeGlobals.entries(), globals.entries()]) {
          let next = entries.next();
          while (!next.done) {
            if (!foundKeys.has(next.value[0])) {
              yield transform(next.value);
              foundKeys.add(next.value[0]);
            }
            next = entries.next();
          }
        }
      }
    }
  }
}
