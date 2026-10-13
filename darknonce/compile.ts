import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import solc from 'solc'

const resolveDependency = createRequire(__filename)
const here = __dirname
const core = path.resolve(here, '../src/ambire-common')
const inputs: [string, string][] = [
  ['Darknonce.sol', path.join(here, 'contracts/Darknonce.sol')],
  [
    '@safe-global/safe-smart-account/contracts/Safe.sol',
    resolveDependency.resolve('@safe-global/safe-smart-account/contracts/Safe.sol')
  ],
  [
    '@safe-global/safe-smart-account/contracts/proxies/SafeProxyFactory.sol',
    resolveDependency.resolve(
      '@safe-global/safe-smart-account/contracts/proxies/SafeProxyFactory.sol'
    )
  ],
  [
    '@account-abstraction/contracts/core/EntryPoint.sol',
    resolveDependency.resolve('@account-abstraction/contracts/core/EntryPoint.sol')
  ]
]
const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources: Object.fromEntries(
        inputs.map(([name, file]) => [name, { content: fs.readFileSync(file, 'utf8') }])
      ),
      settings: {
        optimizer: { enabled: true, runs: 200 },
        viaIR: true,
        evmVersion: 'paris',
        outputSelection: {
          '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] }
        }
      }
    }),
    {
      import: (name: string) => {
        try {
          return { contents: fs.readFileSync(resolveDependency.resolve(name), 'utf8') }
        } catch {
          return { error: `Cannot resolve ${name}` }
        }
      }
    }
  )
)
const errors = (output.errors || []).filter((e: any) => e.severity === 'error')
if (errors.length) throw new Error(errors.map((e: any) => e.formattedMessage).join('\n'))
const wanted = [
  'DarknonceModule',
  'DarknonceGuard',
  'DarknonceSetup',
  'DarknonceBatch',
  'Safe',
  'SafeProxyFactory',
  'EntryPoint'
]
const artifacts = path.join(core, 'contracts/compiled/darknonce')
fs.mkdirSync(artifacts, { recursive: true })
for (const contracts of Object.values(output.contracts) as any[]) {
  for (const [name, contract] of Object.entries(contracts) as any[]) {
    if (!wanted.includes(name)) continue
    fs.writeFileSync(
      path.join(artifacts, `${name}.json`),
      JSON.stringify(
        {
          abi: contract.abi,
          bytecode: `0x${contract.evm.bytecode.object}`,
          deployedBytecode: `0x${contract.evm.deployedBytecode.object}`
        },
        null,
        2
      ) + '\n'
    )
    console.log(`Compiled ${name}`)
  }
}
