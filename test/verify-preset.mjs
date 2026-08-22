// Verify the live preset row exactly as the loader would treat it:
// 1. parse the composition in the loader's own YAML dialect (JSON_SCHEMA + !!js),
// 2. find the hindsight row,
// 3. import the row's `name` as a module (the loader's import step),
// 4. run the row's `config` through the plugin's own Standard Schema validator.
import { load, JSON_SCHEMA, Type } from 'js-yaml'
import { readFileSync } from 'node:fs'

const yml = process.argv[2] ?? '/home/noname/.dsh/.agent-presets/custom/agent.cordis.yml'

const JsExpr = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
})
const schema = JSON_SCHEMA.extend(JsExpr)

let doc
try {
  doc = load(readFileSync(yml, 'utf8'), { schema })
} catch (err) {
  console.error(`FAIL: ${yml} does not parse in the loader dialect: ${err.message}`)
  process.exit(1)
}
if (!Array.isArray(doc)) {
  console.error('FAIL: composition is not a row list')
  process.exit(1)
}
console.log(`parse OK (${yml}): ${doc.length} rows`)

const row = doc.find((r) => r?.id === 'hindsight')
if (row === undefined) {
  console.error('FAIL: no row with id "hindsight"')
  process.exit(1)
}
console.log(`row OK: id=${row.id} name=${row.name}`)
console.log(`        disabled=${String(row.disabled)} inject=${JSON.stringify(row.inject)} group=${String(row.group)}`)

const mod = await import(row.name)
console.log(`import OK: module name="${mod.name}" inject=${JSON.stringify(mod.inject)}`)

if (typeof mod.apply !== 'function' || mod.Config === undefined) {
  console.error('FAIL: module lacks the plugin interface (apply/Config)')
  process.exit(1)
}

const result = mod.Config['~standard'].validate(row.config)
if (result.issues !== undefined) {
  console.error('FAIL: plugin config rejected by its own validator:')
  for (const issue of result.issues) console.error(`  - ${issue.message}${issue.path?.length ? ` (${issue.path.join('.')})` : ''}`)
  process.exit(1)
}
console.log('config OK: validated by the plugin\'s own validator')
console.log('row config as configured:')
for (const [key, value] of Object.entries(row.config)) console.log(`  ${key}: ${JSON.stringify(value)}`)
console.log('\nVERIFIED: this row will mount as the loader will see it')
