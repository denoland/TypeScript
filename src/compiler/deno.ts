/* @internal */
namespace ts.deno {
  export type IsNodeSourceFileCallback = (sourceFile: SourceFile) => boolean;

  let isNodeSourceFile: IsNodeSourceFileCallback = () => false;
  let nodeBuiltInModuleNames = new Set<string>();

  export function setIsNodeSourceFileCallback(callback: IsNodeSourceFileCallback) {
    isNodeSourceFile = callback;
  }

  export function setNodeBuiltInModuleNames(names: string[]) {
    nodeBuiltInModuleNames = new Set(names);
  }

  // When upgrading:
  // 1. Inspect all usages of "globals" and "globalThisSymbol" in checker.ts
  //    - Beware that `globalThisType` might refer to the global `this` type
  //      and not the global `globalThis` type
  // 2. Inspect the types in @types/node for anything that might need to go below
  //    as well.

  const nodeOnlyGlobalNames = new Set([
    "NodeRequire",
    "RequireResolve",
    "RequireResolve",
    "process",
    "console",
    "__filename",
    "__dirname",
    "require",
    "module",
    "exports",
    "gc",
    "BufferEncoding",
    "BufferConstructor",
    "WithImplicitCoercion",
    "Buffer",
    "Console",
    "ImportMeta",
    "setTimeout",
    "setInterval",
    "setImmediate",
    "Global",
    "AbortController",
    "AbortSignal",
    "Blob",
    "BroadcastChannel",
    "MessageChannel",
    "MessagePort",
    "Event",
    "EventTarget",
    "performance",
    "TextDecoder",
    "TextEncoder",
    "URL",
    "URLSearchParams",
  ]) as Set<ts.__String>;

  export function createDenoForkContext({
    mergeSymbol,
    globals,
    nodeGlobals,
    ambientModuleSymbolRegex,
  }: {
    mergeSymbol(target: Symbol, source: Symbol, unidirectional?: boolean): Symbol;
    globals: SymbolTable;
    nodeGlobals: SymbolTable;
    ambientModuleSymbolRegex: RegExp,
  }) {
    return {
      hasNodeSourceFile,
      getGlobalsForName,
      mergeGlobalSymbolTable,
      combinedGlobals: createNodeGlobalsSymbolTable(),
    };

    function hasNodeSourceFile(node: Node | undefined) {
      if (!node) return false;
      const sourceFile = getSourceFileOfNode(node);
      return isNodeSourceFile(sourceFile);
    }

    function getGlobalsForName(id: ts.__String) {
      // Node ambient modules are only accessible in the node code,
      // so put them on the node globals
      if (ambientModuleSymbolRegex.test(id as string)) {
        if ((id as string).startsWith('"node:')) {
          // check if it's a node specifier that we support
          const name = (id as string).slice(6, -1);
          if (nodeBuiltInModuleNames.has(name)) {
            return globals;
          }
        }
        return nodeGlobals;
      }
      return nodeOnlyGlobalNames.has(id) ? nodeGlobals : globals;
    }

    function mergeGlobalSymbolTable(node: Node, source: SymbolTable, unidirectional = false) {
      const sourceFile = getSourceFileOfNode(node);
      const isNodeFile = hasNodeSourceFile(sourceFile);
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
              // Need to convert this to an array since typescript targets ES5
              // and providing back the iterator won't work here. I don't want
              // to change the target to ES6 because I'm not sure if that would
              // surface any issues.
              return arrayFrom(getEntries(kv => kv))[Symbol.iterator]();
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

  export interface NpmPackageReference {
    name: string;
    versionReq: string;
    subPath: string | undefined;
  }

  export function tryParseNpmPackageReference(text: string) {
    try {
      return parseNpmPackageReference(text);
    } catch {
      return undefined;
    }
  }

  export function parseNpmPackageReference(text: string) {
    if (!text.startsWith("npm:")) {
      throw new Error(`Not an npm specifier: ${text}`);
    }
    text = text.replace(/^npm:\/?/, "");
    const parts = text.split("/");
    const namePartLen = text.startsWith("@") ? 2 : 1;
    if (parts.length < namePartLen) {
      throw new Error(`Not a valid package: ${text}`);
    }
    const nameParts = parts.slice(0, namePartLen);
    const lastNamePart = nameParts.at(-1)!;
    const lastAtIndex = lastNamePart.lastIndexOf("@");
    let versionReq: string | undefined = undefined;
    if (lastAtIndex > 0) {
      versionReq = lastNamePart.substring(lastAtIndex + 1);
      nameParts[nameParts.length - 1] = lastNamePart.substring(0, lastAtIndex);
    }
    const name = nameParts.join("/");
    if (name.length === 0) {
      throw new Error(`Npm specifier did not have a name: ${text}`);
    }
    return {
      name,
      versionReq,
      subPath: parts.length > nameParts.length ? parts.slice(nameParts.length).join("/") : undefined,
    };
  }
}
