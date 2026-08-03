#!/usr/bin/env node
import { main } from '../src/cli.mjs'
import { publicError } from '../src/util.mjs'

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
}).catch((error) => {
  process.stderr.write(`orbit: ${publicError(error)}\n`)
  process.exitCode = 1
})
