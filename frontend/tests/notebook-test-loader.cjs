const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { registerHooks } = require('node:module')
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) return nextResolve(pathToFileURL(path.resolve(__dirname, '../src', specifier.slice(2) + '.ts')).href, context)
    if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !path.extname(specifier)) return nextResolve(specifier + '.ts', context)
    return nextResolve(specifier, context)
  },
})
