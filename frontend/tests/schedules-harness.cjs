const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

// 正常项目使用已有 typescript；无依赖沙箱仅可运行擦除类型后的运行时断言。
// 两者都不是 vue-tsc 类型检查，也不替代真实 Dexie/IndexedDB 验收。
let ts
try { ts = require("typescript") } catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error
}
function compile(source) {
  if (ts) return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const names = []
  return require("node:module").stripTypeScriptTypes(source)
    .replace(/import\s+\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']\s*;?/g,
      (_, imports, specifier) => `const { ${imports} } = require(${JSON.stringify(specifier)});\n`)
    .replace(/export\s+(const|function)\s+(\w+)/g, (_, kind, name) => {
      names.push(name)
      return `${kind} ${name}`
    }) + `\n${names.map(name => `exports.${name} = ${name};`).join("\n")}`
}
function loadTS(relative, mocks = {}) {
  const cache = new Map()
  const root = path.resolve(__dirname, "../src")
  function load(filename) {
    filename = path.resolve(filename)
    if (cache.has(filename)) return cache.get(filename)
    const exports = {}
    cache.set(filename, exports)
    const customRequire = name => {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith("@/")) return load(path.join(root, `${name.slice(2)}.ts`))
      if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), `${name}.ts`))
      throw new Error(`未模拟的测试依赖：${name}`)
    }
    vm.runInNewContext(compile(fs.readFileSync(filename, "utf8")), {
      exports, require: customRequire, Date, Set, Map, Number, Array, JSON,
    }, { filename })
    return exports
  }
  return load(path.join(root, relative))
}
function memoryDB() {
  const rows = new Map()
  let failPut = false
  const table = {
    async get(id) { return rows.has(id) ? structuredClone(rows.get(id)) : undefined },
    async add(row) {
      if (rows.has(row.id)) throw new Error("ConstraintError")
      rows.set(row.id, structuredClone(row))
    },
    async put(row) {
      if (failPut) { failPut = false; throw new Error("injected write failure") }
      rows.set(row.id, structuredClone(row))
    },
    where(key) { return { equals: value => ({
      toArray: async () => [...rows.values()].filter(row => row[key] === value).map(row => structuredClone(row)),
    }) } },
  }
  let queue = Promise.resolve()
  const db = {
    schedules: table,
    transaction(_mode, _table, fn) {
      const next = queue.then(async () => {
        const snapshot = structuredClone(rows)
        try { return await fn() } catch (error) {
          rows.clear()
          for (const [id, row] of snapshot) rows.set(id, row)
          throw error
        }
      })
      queue = next.catch(() => {})
      return next
    },
  }
  return { db, rows, failNextPut: () => { failPut = true } }
}
module.exports = { loadTS, memoryDB, compiler: ts ? "typescript" : "node-strip-types" }
