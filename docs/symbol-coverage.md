# Parser-backed symbol inspection

The local symbol module uses **`web-tree-sitter` 0.27.1** and **`@cursorless/tree-sitter-wasms` 0.12.0**. It reads explicitly selected local repository files and does not modify them. Names and ranges come from actual grammar nodes, not regular-expression parsing.

The [official Web Tree-sitter documentation](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md) describes runtime initialization, language loading, ABI compatibility, and the distinction between ESM and CommonJS binding files. The [grammar pack source](https://github.com/cursorless-dev/tree-sitter-wasms) records its upstream grammar revisions. Every grammar below was loaded and exercised against the installed pinned artifacts; availability in a package alone is not counted as function-level coverage.

## APIs

Import from `src/symbols/index.ts`:

```ts
const analysis = await analyzeFile('src/store.ts', source, { assetDirectory })
const checked = await validateDeclaredScopes(repositoryRoot, proposedScopes, { assetDirectory })
const decision = await validateSymbolEdit('src/store.ts', before, after, currentScopes, { assetDirectory })
```

`analyzeFile(path, source, options?)` returns:

```ts
{
  language: string | null,
  qualified: boolean,
  symbols: Array<{
    kind: 'function' | 'container',
    name: string,
    qualifiedName: string,
    startByte: number,
    endByte: number,
    startLine: number,
    endLine: number,
  }>,
  reason?: string,
}
```

Byte ranges are **UTF-8**, with inclusive starts and exclusive ends. Lines are one-based and inclusive. The installed binding exposes JavaScript string offsets for its node indices; these are explicitly converted to UTF-8 byte offsets, including supplementary characters such as emoji. Names preserve case. Containers and nested functions use dot-separated lexical qualification such as `Store.save.validate`; C++ scope-name nodes are normalized to the same separator.

`validateDeclaredScopes(root, scopes, options?)` returns `{ ok, qualified, scopes, files, fallbacks, errors }`. `files` contains `{path, analysis}` records without source contents. `fallbacks` contains `{path, symbol?, reason}`; `errors` contains `{path, reason}`.

- A unique existing qualified symbol retains its symbol scope.
- An unsupported language, syntax error, inaccessible/invalid text, absent function, new file, planned addition/rename, or duplicate/overloaded name becomes an **explicit whole-file scope**, with a fallback reason. The result remains `ok: true`, and `qualified: false` indicates that a requested symbol scope was broadened.
- One uncertain symbol broadens that file as a whole; other symbol scopes in the same file are removed from the normalized result. An existing explicit whole-file claim is never narrowed.
- Invalid paths, traversal, symlink aliases, directory scopes, and unqualified coordinator Unicode identities return `ok: false` and no accepted scopes. The caller must not submit a partial reservation after a fatal validation error.
- New function names do not have trustworthy current AST ranges. They require whole-file reservations in this implementation; no placeholder range is invented.

The caller must submit the returned normalized scopes to the authoritative coordinator and show any broadening before work starts. This inspection does not itself create reservations, approve tasks, check current ownership/revisions, or compare remote branches.

## Tested grammar and adapter matrix

| Language | Extensions | Installed grammar ABI | Fixture-qualified constructs |
| --- | --- | --- | --- |
| JavaScript / JSX | `.js`, `.jsx`, `.mjs`, `.cjs` | 14 | Named functions, classes/methods, nested functions, assigned arrows, JSX components. |
| TypeScript | `.ts`, `.mts`, `.cts` | 14 | Typed functions/methods/arrows, nested functions, classes, overload ambiguity fallback. |
| TSX | `.tsx` | 14 | Components, nested assigned render functions, JSX expressions. |
| Python | `.py`, `.pyi` | 14 | Functions, classes/methods, nested functions, decorator-inclusive definition ranges. |
| Go | `.go` | 14 | Functions, named structs, methods on simple named/pointer receivers. |
| Rust | `.rs` | 13 | Functions, structs, simple named `impl` methods, nested functions. |
| Java | `.java` | 14 | Named classes, constructors, methods. |
| C | `.c` | 14 | Named structs and ordinary function declarators/definitions. |
| C++ | `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, `.hxx` | 14 | Namespaces, named classes, inline methods, ordinary functions. |
| C# | `.cs` | 13 | Block namespaces, named classes, constructors, methods, local functions. |
| Ruby | `.rb` | 14 | Modules, named classes, methods, top-level method definitions. |
| PHP | `.php` | 14 | Classes/methods, named functions, lexically nested named functions. |
| Swift | `.swift` | 14 | Named classes, methods, functions, nested functions. |
| Kotlin | `.kt`, `.kts` | 14 | Named classes, methods, functions, nested functions. |

The runtime reports ABI compatibility **13–15**. All fourteen installed grammars fall within it and successfully parse their fixtures. The C# grammar in this pack is an older grammar; modern syntax not understood by it falls back to whole-file scope. Generic Go receivers, complex Rust implementation types, anonymous/unreliably named declarations, and other unqualified constructs also take the conservative fallback. A `.h` file is ambiguous between C and C++ and currently receives whole-file treatment. Every other extension remains usable through whole-file reservations.

These are lexical source ranges, not a compiler symbol table or a cross-file dependency graph. Overloads with the same qualified name are not separated by invented signatures. Runtime-defined methods, macros, namespace resolution, generated outputs, shared interfaces, and semantic dependencies still need conservative declared scopes. Different function names do not establish independent behavior or guarantee conflict-free merges.

## Interior edit proof

`validateSymbolEdit(path, before, after, scopes, options?)` returns `{allow, reason, symbol?}` and performs no filesystem writes.

For symbol reservations, it parses both source versions and computes the changed interval by removing their common prefix and suffix. It allows the change only when that entire interval is **strictly inside the same uniquely identified existing function** in both trees. A reserved parent class or outer function may cover an existing nested function through the coordinator's qualified-name containment rules. A class header or unrelated top-level change is not an interior function edit.

Adding, deleting, or renaming named functions requires a whole-file reservation. Recovered syntax errors, unqualified grammars, duplicate identities, missing claims, and intervals crossing function boundaries are refused. A combined edit spanning two sibling functions is conservatively refused even when both are reserved; separate proven edits or a whole-file claim are needed. Whole-file reservations authorize the entire file without requiring a supported grammar.

This content proof must be combined with the existing live task/revision/session/authority gate. The caller must reconstruct the actual proposed text from a known native edit tool and compare against the current local file. It does not authorize opaque shell commands, stop already-running processes, prevent a simultaneous external filesystem write, or audit a remote disconnected clone.

## Runtime assets and bounds

Packaged callers pass an explicit `assetDirectory`. Copy these files into the flat directory:

- `node_modules/web-tree-sitter/web-tree-sitter.js` as **`web-tree-sitter.mjs`**.
- `node_modules/web-tree-sitter/web-tree-sitter.wasm`.
- `tree-sitter-{javascript,typescript,tsx,python,go,rust,java,c,cpp,c_sharp,ruby,php,swift,kotlin}.wasm` from `node_modules/@cursorless/tree-sitter-wasms/out/`.

The JavaScript binding is imported dynamically as a native ESM file. Bundling its ESM source into Electron's CommonJS main erases its internal `import.meta.url` and breaks initialization; copying only the Wasm files is insufficient. Fresh subprocess tests prove both ESM and CommonJS application bundles can parse using only the copied assets, outside the project directory, without installed development dependencies. Missing/incompatible assets produce a whole-file fallback instead of a fake symbol grant.

Development defaults resolve the pinned npm files. No grammar is downloaded at analysis time, and the inspected repository cannot supply its own parser. A process initializes one runtime; copied runtime/binding bytes must match that runtime before cached language handles are reused.

Individual source analysis is limited to 2 MiB, a cooperative 500 ms parsing budget, and 100,000 visited named syntax nodes. Declared-scope validation reads/parses files sequentially to bound memory, checks selected paths and regular-file status, rejects symlink aliases, and falls back if text changes during inspection or cannot be decoded as UTF-8. Syntax trees and parser instances are explicitly released after inspection.

Run the focused checks with `npx vitest run src/symbols`. The fixtures cover all listed adapters, Unicode byte offsets, nested/class containment, new/missing/overloaded symbols, parse failures, unknown languages, safe selected-repository reads, interior edit refusals, and copied-asset ESM/CommonJS loading. Real client gating and packaged macOS testing remain separate qualification steps.
